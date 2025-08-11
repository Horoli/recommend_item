// services/optimizer.js
const TTLCache = require("./cache");
let pLimit;
(async () => {
  pLimit = (await import("p-limit")).default;
})();

const priceCache = new TTLCache(
  Number(process.env.PRICE_TTL_MS ?? 600_000), // 10분
  Number(process.env.PRICE_CACHE_MAX ?? 5000)
);

class Optimizer {
  static wait(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  static async fetchPricesByItemId(
    itemIds,
    dfApi,
    { concurrency = 8, timeoutMs = 6000 } = {}
  ) {
    const unique = Array.from(new Set(itemIds));
    const limit = pLimit(concurrency);
    const map = new Map();

    // 캐시 히트 먼저 채우기
    const need = [];
    for (const id of unique) {
      const cached = priceCache.get(id);
      if (cached) map.set(id, cached);
      else need.push(id);
    }
    if (need.length === 0) return map;

    // 병렬 호출 (부분 실패 허용)
    const tasks = need.map((id) =>
      limit(async () => {
        try {
          const controller = new AbortController();
          const t = setTimeout(() => controller.abort(), timeoutMs);
          const info = await dfApi.getAuctionLowestPrice(id, {
            signal: controller.signal,
          });
          clearTimeout(t);
          if (info) {
            priceCache.set(id, info);
            map.set(id, info);
          } else map.set(id, null);
        } catch {
          map.set(id, null);
        }
      })
    );
    await Promise.allSettled(tasks);
    return map;
  }

  // 동일 슬롯 내 지배 제거
  static pruneDominated(candsPerSlot) {
    // price.lowestPrice 기준 정렬
    candsPerSlot.sort(
      (a, b) =>
        a.price.lowestPrice - b.price.lowestPrice || b.deltaScore - a.deltaScore
    );
    const out = [];
    let bestDelta = -Infinity;
    for (const c of candsPerSlot) {
      if (c.deltaScore > bestDelta) {
        out.push(c);
        bestDelta = c.deltaScore;
      }
    }
    return out;
  }

  // 후보 생성(풀업 스탯) → 가격조회(최저가 상세) → 카드만 + price null 제거 → 지배 제거
  static async buildCandidatesWithPrices(
    equipment,
    currentBySlot,
    Enchants,
    dfApi,
    options = {}
  ) {
    const {
      deltaMin = Number(process.env.DELTA_MIN ?? 50),
      topDeltaPerSlot = Number(process.env.TOP_DELTA_PER_SLOT ?? 8),
      priceLookupDelay = Number(process.env.PRICE_LOOKUP_DELAY ?? 120),
    } = options;

    const rough = [];
    for (const eq of equipment) {
      const base = currentBySlot.get(eq.slotId)?.currentScore ?? 0;
      // 풀업(2/2) 기준 후보
      const slotCands = Enchants.getMaxUpgradeCandidatesForSlot(eq.slotId, 2);

      // 같은 itemId는 하나만(풀업만 쓰니 OK) + 카드만
      const seen = new Set();
      const perSlot = [];
      for (const c of slotCands) {
        if (seen.has(c.itemId)) continue;
        if (!(c.itemName || "").includes("카드")) continue; // ← 카드만
        seen.add(c.itemId);

        const delta = c.score - base;
        if (delta <= 0 || delta < deltaMin) continue;

        perSlot.push({
          slotId: eq.slotId,
          slotName: eq.slotName,
          equippedItemName: eq.itemName,
          itemId: c.itemId,
          itemName: c.itemName,
          upgrade: c.upgrade, // 표시용(풀업)
          candidateScore: c.score, // 풀업 점수
          baseScore: base,
          deltaScore: delta,
          price: null, // 나중에 상세객체 주입
          efficiency: null,
          status: c.status,
          rarity: c.rarity,
        });
      }

      // 슬롯당 델타 상위 N개
      perSlot.sort((a, b) => b.deltaScore - a.deltaScore);
      rough.push(...perSlot.slice(0, topDeltaPerSlot));
    }

    if (!rough.length) return new Map();

    // 가격 상세 객체 조회
    const priceMap = await this.fetchPricesByItemId(
      rough.map((r) => r.itemId),
      dfApi,
      priceLookupDelay
    );

    // 가격 주입 + null 제거 + 효율 계산(최저가 기준)
    const priced = rough
      .map((r) => ({ ...r, price: priceMap.get(r.itemId) ?? null }))
      .filter(
        (r) =>
          r.price &&
          Number.isFinite(r.price.lowestPrice) &&
          r.price.lowestPrice > 0
      )
      .map((r) => ({ ...r, efficiency: r.deltaScore / r.price.lowestPrice }));

    // 슬롯별 묶기 + 지배 제거
    const slotMap = new Map();
    for (const c of priced) {
      if (!slotMap.has(c.slotId)) slotMap.set(c.slotId, []);
      slotMap.get(c.slotId).push(c);
    }
    for (const [slotId, arr] of slotMap) {
      slotMap.set(slotId, this.pruneDominated(arr));
    }
    return slotMap;
  }

  // 멀티초이스 배낭(MCKP): 가격은 price.lowestPrice 사용
  static selectByBudgetMCKP(slotMap, budget, priceUnit = 100000) {
    const groups = Array.from(slotMap.values()).filter(
      (arr) => arr && arr.length
    );
    if (!groups.length)
      return { chosen: [], spent: 0, remain: budget, totalDelta: 0 };

    const cap = Math.max(0, Math.floor(budget / priceUnit));
    const NEG = -1e18;
    const dp = new Array(cap + 1).fill(0);
    const choice = Array.from({ length: groups.length }, () =>
      new Array(cap + 1).fill(-1)
    );

    groups.forEach((group, gi) => {
      const ndp = new Array(cap + 1).fill(NEG);
      const nchoice = new Array(cap + 1).fill(-1);

      for (let w = 0; w <= cap; w++) {
        ndp[w] = dp[w];
        nchoice[w] = -1;
      }

      for (let w = 0; w <= cap; w++) {
        if (dp[w] === NEG) continue;
        for (let idx = 0; idx < group.length; idx++) {
          const it = group[idx];
          const p = Math.floor(it.price.lowestPrice / priceUnit);
          if (p <= 0) continue;
          const nw = w + p;
          if (nw > cap) continue;
          const val = dp[w] + it.deltaScore;
          if (val > ndp[nw]) {
            ndp[nw] = val;
            nchoice[nw] = idx;
          }
        }
      }

      for (let w = 0; w <= cap; w++) {
        dp[w] = ndp[w];
        choice[gi][w] = nchoice[w];
      }
    });

    let bestW = 0;
    for (let w = 1; w <= cap; w++) if (dp[w] > dp[bestW]) bestW = w;

    const chosen = [];
    let w = bestW;
    for (let gi = groups.length - 1; gi >= 0; gi--) {
      const idx = choice[gi][w];
      if (idx >= 0) {
        const it = groups[gi][idx];
        chosen.push(it);
        w -= Math.floor(it.price.lowestPrice / priceUnit);
      }
    }

    const spent = chosen.reduce((s, x) => s + x.price.lowestPrice, 0);
    return {
      chosen: chosen.reverse(),
      spent,
      remain: Math.max(0, budget - spent),
      totalDelta: Math.max(0, dp[bestW]),
    };
  }
}

module.exports = Optimizer;
