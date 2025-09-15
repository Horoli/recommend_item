// services/enchants.js
const fs = require("fs");
const path = require("path");

class Enchants {
  static DATA_FILE = path.resolve(
    __dirname,
    "../data/recommend_item_details.json"
  );

  static WEIGHTS = {
    _공격력: 0.7,
    _속성강화: 25, // 동적 보정의 베이스
    _능력치: 0.6,
    "공격력 증폭": 100,
    "최종 데미지": 120,
    "모험가 명성": 0,
  };

  // 네 원소 키(정규화 형태)
  static ELEMENT_ENH_KEYS = [
    "화속성강화",
    "수속성강화",
    "명속성강화",
    "암속성강화",
  ];

  // -------- file I/O --------
  static readJSONSafe(fp, fb) {
    try {
      if (!fs.existsSync(fp)) return fb;
      return JSON.parse(fs.readFileSync(fp, "utf-8"));
    } catch {
      return fb;
    }
  }
  static loadEnchantCatalog() {
    const raw = this.readJSONSafe(this.DATA_FILE, { enchants: [] });
    if (Array.isArray(raw)) return { enchants: raw };
    return { enchants: Array.isArray(raw.enchants) ? raw.enchants : [] };
  }

  // -------- normalize & map --------
  static normalizeValue(v) {
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const s = v.trim().replace(/,/g, "");
      const m = s.match(/-?\d+(\.\d+)?/);
      if (m) return parseFloat(m[0]);
    }
    return NaN;
  }
  static normalizeName(name) {
    return String(name || "")
      .trim()
      .replace(/\s+/g, "");
  }
  static isAttackStatKey(key) {
    const k = this.normalizeName(key);
    return k === "물리공격력" || k === "마법공격력" || k === "독립공격력";
  }
  static isAbilityStatKey(key) {
    const k = this.normalizeName(key);
    return k === "힘" || k === "지능" || k === "정신력" || k === "체력";
  }
  static weightForStatKey(key) {
    const k = this.normalizeName(key);
    if (k === "속성강화(유효)") return this.WEIGHTS._속성강화;
    if (this.isAttackStatKey(k)) return this.WEIGHTS._공격력;
    if (this.isAbilityStatKey(k)) return this.WEIGHTS._능력치;
    if (k === "공격력증폭") return this.WEIGHTS["공격력 증폭"] ?? 0;
    if (k === "최종데미지") return this.WEIGHTS["최종 데미지"] ?? 0;
    if (k === "모험가명성" || k === "모험가 명성") return 0;
    return this.WEIGHTS[key] ?? 0;
  }
  static toStatMap(statusList = []) {
    const map = {};
    for (const s of statusList || []) {
      const key = this.normalizeName(s.name);
      const v = this.normalizeValue(s.value);
      if (!Number.isFinite(v)) continue;
      map[key] = (map[key] || 0) + v;
    }
    return map;
  }

  // 캐릭터 status 배열에서 "가장 높은 속강 타입" 반환 (예: "화속성강화")
  static pickTopElementKeyFromStatus(statusList = []) {
    const m = this.toStatMap(statusList);
    let bestKey = null,
      bestVal = -Infinity;
    for (const k of this.ELEMENT_ENH_KEYS) {
      const v = Number(m[k] || 0);
      if (v > bestVal) {
        bestVal = v;
        bestKey = k;
      }
    }
    return bestKey;
  }

  // (모든속성강화 + 각 원소강화) 를 더해 원소 중 최댓값을 유효 속강으로 계산
  static effectiveElementBest(map = {}, baseline = {}) {
    const vAll = Number(map["모든속성강화"] || 0);
    let best = 0;
    for (const k of this.ELEMENT_ENH_KEYS) {
      const base = Number(baseline[k] || 0); // 기본은 0 사용 (baseline 미반영)
      const v = base + Number(map[k] || 0) + vAll; // 각 원소에 '모속강'을 가산
      if (v > best) best = v;
    }
    return best;
  }

  // -------- diff (Δ×가중치) --------
  // baseline 보정 없이, 현재 마부 vs 후보 마부만 비교
  static diffStatusArrays(currentStatus = [], recStatus = []) {
    const curRaw = this.toStatMap(currentStatus);
    const recRaw = this.toStatMap(recStatus);

    // 유효 속강 = (각 원소강화 + 모든속성강화)의 최대값
    const curEffElem = this.effectiveElementBest(curRaw, {}); // baseline 미사용
    const recEffElem = this.effectiveElementBest(recRaw, {});
    const elemDelta = recEffElem - curEffElem;

    const byStat = {
      "속성강화(유효)": {
        current: curEffElem,
        recommended: recEffElem,
        delta: elemDelta,
      },
    };

    // 카테고리 최대치 반영: 능력치 1개, 공격력 1개만 점수화
    let bestAbility = { key: null, delta: 0 };
    let bestAttack = { key: null, delta: 0 };

    const keys = new Set([...Object.keys(curRaw), ...Object.keys(recRaw)]);
    for (const k of keys) {
      const nk = this.normalizeName(k);
      if (nk === "모험가명성") continue;
      if (nk === "모든속성강화" || this.ELEMENT_ENH_KEYS.includes(nk)) continue; // 원소는 유효값으로만 처리

      const c = Number(curRaw[k] || 0);
      const r = Number(recRaw[k] || 0);
      if (!c && !r) continue;

      const delta = r - c;
      byStat[k] = { current: c, recommended: r, delta };

      if (this.isAbilityStatKey(nk)) {
        if (bestAbility.key === null || delta > bestAbility.delta)
          bestAbility = { key: k, delta };
      } else if (this.isAttackStatKey(nk)) {
        if (bestAttack.key === null || delta > bestAttack.delta)
          bestAttack = { key: k, delta };
      }
    }

    const elemW = this.WEIGHTS._속성강화 ?? 25;
    const abilityW = this.WEIGHTS._능력치 ?? 0.6;
    const attackW = this.WEIGHTS._공격력 ?? 3;

    const elemScore = elemW * (elemDelta || 0);
    const abilityScore = abilityW * (bestAbility.delta || 0);
    const attackScore = attackW * (bestAttack.delta || 0);

    // 나머지(공증/최데 등)는 개별 합산
    let othersScore = 0;
    for (const [k, v] of Object.entries(byStat)) {
      const nk = this.normalizeName(k);
      if (
        k === "속성강화(유효)" ||
        this.isAbilityStatKey(nk) ||
        this.isAttackStatKey(nk)
      )
        continue;
      const w = this.weightForStatKey(k);
      if (w) othersScore += w * (v.delta || 0);
    }

    const deltaScore = elemScore + abilityScore + attackScore + othersScore;
    return { byStat, meta: { elemDelta, deltaScore } };
  }

  // -------- catalog → candidates --------
  static candidateFromItemForSlot(item, slot, targetUpgrade = null) {
    const enchArr = item?.cardInfo?.enchant || [];
    if (!enchArr.length) return null;

    let chosen;
    if (targetUpgrade != null) {
      chosen = enchArr.find((e) => (e.upgrade ?? 0) === targetUpgrade);
    } else {
      chosen = enchArr[enchArr.length - 1]; // 배열 마지막 = 풀업
    }
    if (!chosen) {
      chosen = enchArr.reduce(
        (a, b) => ((a?.upgrade ?? 0) > (b?.upgrade ?? 0) ? a : b),
        null
      );
    }
    if (!chosen) return null;

    const status = Array.isArray(chosen.status) ? chosen.status : [];
    return {
      itemId: item.itemId,
      itemName: item.itemName,
      slotId: slot.slotId,
      slotName: slot.slotName,
      upgrade: chosen.upgrade ?? 0,
      status,
      rarity: item.itemRarity,
    };
  }

  static getMaxUpgradeCandidatesForSlot(slotId) {
    const { enchants } = this.loadEnchantCatalog();
    const out = [];
    for (const item of enchants) {
      const slots = item?.cardInfo?.slots || [];
      for (const slot of slots) {
        if (slot.slotId !== slotId) continue;
        const cand = this.candidateFromItemForSlot(item, slot, null);
        if (cand) out.push(cand);
      }
    }
    return out;
  }

  // -------- evaluation --------
  // ctx.filterElemKey 가 있으면, 그 원소 or '모든속성강화' 카드만 남김
  static evaluateEnchantForEquipment(equip, limit = 3, ctx = {}) {
    const slotId = equip?.slotId;
    const currentStats = this.toStatMap(equip?.enchant?.status || []);
    const candidates = this.getMaxUpgradeCandidatesForSlot(slotId);

    const filterKey = ctx.filterElemKey
      ? this.normalizeName(ctx.filterElemKey)
      : null;

    const enriched = [];
    for (const c of candidates) {
      const recStats = this.toStatMap(c.status);

      if (filterKey) {
        // 원소 강화가 들어있는지(모속/개별 원소) 먼저 체크
        const hasAll = Number(recStats["모든속성강화"] || 0) > 0;
        const hasAnyElem =
          hasAll ||
          this.ELEMENT_ENH_KEYS.some((k) => Number(recStats[k] || 0) > 0);

        // 원소가 있는 카드만 엄격히 필터; 원소가 전혀 없는 카드는 허용
        const matchesTop = hasAll || Number(recStats[filterKey] || 0) > 0;

        if (hasAnyElem && !matchesTop) {
          continue; // 다른 원소 강화 카드면 제외
        }
      }

      const diff = this.diffStatusArrays(
        equip?.enchant?.status || [],
        c.status
      );

      enriched.push({
        itemId: c.itemId,
        itemName: c.itemName,
        slotId: c.slotId,
        slotName: c.slotName,
        upgrade: c.upgrade,
        rarity: c.rarity,
        score: diff.meta.deltaScore, // Δ×가중치 점수
        recStats,
        diff,
      });
    }

    const better = enriched
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, Number(limit) || 3));

    return {
      slotId,
      slotName: equip?.slotName,
      equippedItemId: equip?.itemId,
      equippedItemName: equip?.itemName,
      currentStats, // 장비의 현재 마부만
      recommended: better,
    };
  }

  static evaluateAllEquipment(equipmentList = [], limit = 3, ctx = {}) {
    return equipmentList.map((eq) =>
      this.evaluateEnchantForEquipment(eq, limit, ctx)
    );
  }
}

module.exports = Enchants;
