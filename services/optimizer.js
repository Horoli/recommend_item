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

  // ✅ 풀업(업그레이드 2)만 남기는 필터
  static keepOnlyUpgrade2(cands = []) {
    return (cands || []).filter((c) => Number(c?.upgrade ?? 0) === 2);
  }

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

      // ⚠️ targetUpgrade=2를 주더라도 Enchants 쪽에서 해당 단계가 없으면 최댓값으로 대체됨(=3 가능)
      let slotCands = Enchants.getMaxUpgradeCandidatesForSlot(eq.slotId, 2);

      // ✅ 같은 itemId+slotId 묶음에서 "최고 업그레이드만" 유지 (2 또는 3 등)
      slotCands = this.keepOnlyHighestUpgrade(slotCands);

      // 같은 itemId는 하나만 + 카드만
      const seen = new Set();
      const perSlot = [];
      for (const c of slotCands) {
        // ✅ 루프 레벨에서도 방어: 최고 업그레이드가 아닌 엔트리 스킵
        // (keepOnlyHighestUpgrade 이후라 이 라인은 사실상 안전망)
        const key = `${c.itemId}:${c.slotId}`;
        if (seen.has(c.itemId)) continue;
        if (!(c.itemName || "").includes("카드")) continue; // 카드만
        seen.add(c.itemId);

        const delta = c.score - base;
        if (delta <= 0 || delta < deltaMin) continue;

        perSlot.push({
          slotId: eq.slotId,
          slotName: eq.slotName,
          equippedItemName: eq.itemName,
          itemId: c.itemId,
          itemName: c.itemName,
          upgrade: c.upgrade, // 표시용 (2 또는 3 등 최고치)
          candidateScore: c.score,
          baseScore: base,
          deltaScore: delta,
          price: null,
          efficiency: null,
          status: c.status,
          rarity: c.rarity,
        });
      }

      perSlot.sort((a, b) => b.deltaScore - a.deltaScore);
      rough.push(...perSlot.slice(0, topDeltaPerSlot));
    }

    if (!rough.length) return new Map();

    // ✅ 가격 조회 전에도 한 번 더 최고 업그레이드만 유지 (다중 경로 방어)
    const roughFull = this.keepOnlyHighestUpgrade(rough);

    // 가격 상세 객체 조회
    const priceMap = await this.fetchPricesByItemId(
      roughFull.map((r) => r.itemId),
      dfApi,
      // NOTE: 여기는 { concurrency, timeoutMs } 옵션 객체를 넘기는 자리입니다.
      // 필요 시 { concurrency: 8, timeoutMs: priceLookupDelay }로 맞추세요.
      undefined
    );

    const priced = roughFull
      .map((r) => ({ ...r, price: priceMap.get(r.itemId) ?? null }))
      .filter(
        (r) =>
          r.price &&
          Number.isFinite(r.price.lowestPrice) &&
          r.price.lowestPrice > 0
      )
      .map((r) => ({ ...r, efficiency: r.deltaScore / r.price.lowestPrice }));

    const slotMap = new Map();
    for (const c of priced) {
      if (!slotMap.has(c.slotId)) slotMap.set(c.slotId, []);
      slotMap.get(c.slotId).push(c);
    }
    for (const [slotId, arr] of slotMap) {
      // ✅ 최종 반환 전에도 최고 업그레이드만 유지 → 지배 제거
      slotMap.set(
        slotId,
        this.pruneDominated(this.keepOnlyHighestUpgrade(arr))
      );
    }
    return slotMap;
  }

  // 멀티초이스 배낭(MCKP): 가격은 price.lowestPrice 사용
  static selectByBudgetMCKP(
    slotMap,
    budget,
    priceUnit = 100000,
    sortMode = process.env.PLAN_SORT_MODE ?? "eff"
  ) {
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

    const chosenRev = chosen.reverse();

    const eff = (x) =>
      x?.price?.lowestPrice > 0
        ? (x.deltaScore ?? x.score ?? 0) / x.price.lowestPrice
        : -Infinity;
    const cmpEff = (a, b) =>
      eff(b) - eff(a) ||
      (b.deltaScore ?? b.score ?? 0) - (a.deltaScore ?? a.score ?? 0) ||
      (a.price?.lowestPrice ?? Infinity) - (b.price?.lowestPrice ?? Infinity);

    const cmpScore = (a, b) =>
      (b.deltaScore ?? b.score ?? 0) - (a.deltaScore ?? a.score ?? 0) ||
      eff(b) - eff(a) ||
      (a.price?.lowestPrice ?? Infinity) - (b.price?.lowestPrice ?? Infinity);

    const sortedChosen = chosenRev.sort(sortMode === "eff" ? cmpEff : cmpScore);

    const spent = sortedChosen.reduce((s, x) => s + x.price.lowestPrice, 0);

    return {
      chosen: sortedChosen,
      spent,
      remain: Math.max(0, budget - spent),
      totalDelta: Math.max(0, dp[bestW]),
    };
  }

  // (참고용) 최고 업그레이드만 유지 — 현재는 keepOnlyUpgrade2로 대체 가능
  static keepOnlyHighestUpgrade(cands = []) {
    const best = new Map();
    for (const c of cands) {
      const key = `${c.itemId}:${c.slotId}`;
      const prev = best.get(key);
      const u = Number(c.upgrade ?? 0);
      const uprev = Number(prev?.upgrade ?? -1);
      if (!prev || u > uprev) best.set(key, c);
    }
    return Array.from(best.values());
  }
}

module.exports = Optimizer;
