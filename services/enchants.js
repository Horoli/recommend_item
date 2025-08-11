// services/enchants.js
const fs = require("fs");
const path = require("path");

class Enchants {
  static DATA_FILE = path.resolve(
    __dirname,
    "../data/recommend_item_details.json"
  );

  static WEIGHTS = {
    // 개별 키 가중치(필요 시 추가)
    _공격력: 3,
    _속성강화: 25,
    _능력치: 0.6,
    "공격력 증폭": 100,
    "최종 데미지": 120,
    "모험가 명성": 0,
  };

  static ELEMENT_DAMAGES = new Set([
    "물리 공격력",
    "마법 공격력",
    "독립 공격력",
  ]);

  static ELEMENT_ATTRIBUTES = new Set(["힘", "지능", "정신력", "체력"]);
  static ELEMENT_NAMES = new Set([
    "모든 속성 강화",
    "화속성강화",
    "수속성강화",
    "명속성강화",
    "암속성강화",
    "화속성 강화",
    "수속성 강화",
    "명속성 강화",
    "암속성 강화",
  ]);

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

  // 문자열("3%","1,234.5")도 숫자로 변환
  static normalizeValue(v) {
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const s = v.trim().replace(/,/g, "");
      const m = s.match(/-?\d+(\.\d+)?/);
      if (m) return parseFloat(m[0]);
    }
    return NaN;
  }

  // ✅ 이름 정규화: '화속성강화' == '화속성 강화' 통일
  static normalizeName(name) {
    return String(name || "")
      .trim()
      .replace(/\s+/g, "");
  }

  // --- 스탯 분류 & 가중치 매핑(Δ×가중치에 사용) ---
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
    // 혹시 개별 키에 가중치를 직접 줄 때 대비(정규화 없이 원본 키로 매핑)
    return this.WEIGHTS[key] ?? 0;
  }

  // status 배열 -> { [name]: sumValue } 맵으로 변환
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

  static pickEffectiveElement(map = {}) {
    const keys = [
      "모든속성강화",
      "화속성강화",
      "수속성강화",
      "명속성강화",
      "암속성강화",
    ];
    let bestKey = null;
    let bestVal = 0;
    for (const k of keys) {
      const v = Number(map[k] || 0);
      if (v > bestVal) {
        bestVal = v;
        bestKey = k;
      }
    }
    return { key: bestKey, value: bestVal };
  }

  // diff 계산 시, 원소는 '속성강화(유효)' 하나로만 비교하도록 접기
  static collapseElementForDiff(map = {}) {
    const m = { ...map };
    const { value } = this.pickEffectiveElement(m);

    const elemKeys = [
      "모든속성강화",
      "화속성강화",
      "수속성강화",
      "명속성강화",
      "암속성강화",
    ];
    for (const k of elemKeys) delete m[k];

    m["속성강화(유효)"] = value > 0 ? value : 0;
    return m;
  }

  // ✅ 카테고리당 최고 델타만 점수에 반영하는 diff
  static diffStatusArrays(currentStatus = [], recStatus = []) {
    const curRaw = this.toStatMap(currentStatus);
    const recRaw = this.toStatMap(recStatus);

    const cur = this.collapseElementForDiff(curRaw); // 원소는 '속성강화(유효)' 하나만 남김
    const rec = this.collapseElementForDiff(recRaw);

    // 합집합 키
    const keys = new Set([...Object.keys(cur), ...Object.keys(rec)]);

    const byStat = {};
    let bestAbility = { key: null, delta: 0 };
    let bestAttack = { key: null, delta: 0 };

    for (const k of keys) {
      // 모험가 명성은 제외
      if (k === "모험가명성" || k === "모험가 명성") continue;

      const c = Number(cur[k] || 0);
      const r = Number(rec[k] || 0);
      if (!c && !r) continue;

      const delta = r - c;
      byStat[k] = { current: c, recommended: r, delta };

      const nk = this.normalizeName(k);
      if (this.isAbilityStatKey(nk)) {
        if (bestAbility.key === null || delta > bestAbility.delta) {
          bestAbility = { key: k, delta };
        }
      } else if (this.isAttackStatKey(nk)) {
        if (bestAttack.key === null || delta > bestAttack.delta) {
          bestAttack = { key: k, delta };
        }
      }
    }

    const elemDelta = byStat["속성강화(유효)"]?.delta ?? 0;

    // 🔥 점수 계산: 원소1 + 능력치 최대1 + 공격력 최대1 + 나머지(가중치 있는 키들) 합
    const elemW = this.weightForStatKey("속성강화(유효)");
    const abilityW = this.WEIGHTS._능력치 ?? 0;
    const attackW = this.WEIGHTS._공격력 ?? 0;

    const elemScore = elemW * elemDelta;
    const abilityScore = abilityW * (bestAbility.delta || 0);
    const attackScore = attackW * (bestAttack.delta || 0);

    // 그 외(능력치/공격력/원소 제외) 키는 전부 개별 합산
    let othersScore = 0;
    for (const [k, v] of Object.entries(byStat)) {
      if (
        k === "속성강화(유효)" ||
        this.isAbilityStatKey(this.normalizeName(k)) ||
        this.isAttackStatKey(this.normalizeName(k))
      ) {
        continue;
      }
      const w = this.weightForStatKey(k);
      if (w) othersScore += w * (v.delta || 0);
    }

    const deltaScore = elemScore + abilityScore + attackScore + othersScore;

    return {
      byStat,
      meta: {
        elemDelta,
        // bestAbility, // { key, delta }
        // bestAttack, // { key, delta }
        deltaScore,
      },
    };
  }

  // 특정 아이템의 주어진 upgrade 데이터(기본: 마지막 값)만 뽑아 candidate 생성
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
      status, // ⬅️ score 필드 제거
      rarity: item.itemRarity,
    };
  }

  // 슬롯 후보(풀업) 수집. 정렬은 evaluate에서 Δ점수 기준으로 수행
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

  // ✅ 장비 한 부위 평가: diff 기반 점수만 사용, recommended에서 currentStats/status 제거
  static evaluateEnchantForEquipment(equip, limit = 3) {
    const slotId = equip?.slotId;

    // 슬롯 단위의 현재 스탯 맵 (여기만 유지)
    const currentStats = this.toStatMap(equip?.enchant?.status || []);

    const candidates = this.getMaxUpgradeCandidatesForSlot(slotId);

    const enriched = candidates.map((c) => {
      const recStats = this.toStatMap(c.status);
      const diff = this.diffStatusArrays(
        equip?.enchant?.status || [],
        c.status
      );

      // status 제거하고 필요한 필드만 구성
      return {
        itemId: c.itemId,
        itemName: c.itemName,
        slotId: c.slotId,
        slotName: c.slotName,
        upgrade: c.upgrade,
        rarity: c.rarity,
        score: diff.meta.deltaScore, // Δ×가중치 점수
        recStats, // 추천 합산 스탯 맵
        diff, // { byStat, meta }
      };
    });

    const better = enriched
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, Number(limit) || 3));

    return {
      slotId,
      slotName: equip?.slotName,
      equippedItemName: equip?.itemName,
      currentStats, // ⬅️ 슬롯 단 한 번만 제공
      recommended: better,
    };
  }
  static evaluateAllEquipment(equipmentList = [], limit = 3) {
    return equipmentList.map((eq) =>
      this.evaluateEnchantForEquipment(eq, limit)
    );
  }
}

module.exports = Enchants;
