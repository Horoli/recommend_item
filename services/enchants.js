// services/enchants.js
const fs = require("fs");
const path = require("path");

class Enchants {
  static DATA_FILE = path.resolve(
    __dirname,
    "../data/recommend_item_details.json"
  );

  static WEIGHTS = {
    // "물리 공격력": 4,
    // "마법 공격력": 4,
    // "독립 공격력": 4,
    _공격력: 4,
    _속성강화: 80,
    _능력치: 50,
    "공격력 증폭": 40,
    "최종 데미지": 100,
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

  // ⬇️ 추가: 문자열("3%","1,234.5")도 숫자로 변환
  static normalizeValue(v) {
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const s = v.trim().replace(/,/g, "");
      // 퍼센트 기호는 제거하고 수치만 사용 (예: "3%" -> 3)
      const m = s.match(/-?\d+(\.\d+)?/);
      if (m) return parseFloat(m[0]);
    }
    return NaN; // 숫자 아님
  }

  // 기존 scoreStatus를 아래처럼 교체
  static scoreStatus(statusList) {
    let score = 0;

    let hasElement = false; // _속성강화
    let hasAbility = false; // _능력치
    let hasAtkStat = false; // 물/마/독 공통

    for (const s of statusList) {
      const name = s.name.trim();
      const value = parseFloat(s.value);

      if (Enchants.ELEMENT_NAMES.has(name)) {
        if (!hasElement) {
          score += Enchants.WEIGHTS._속성강화 * value;
          hasElement = true;
        }
        continue;
      }

      if (Enchants.ELEMENT_ATTRIBUTES.has(name)) {
        if (!hasAbility) {
          score += Enchants.WEIGHTS._능력치 * value;
          hasAbility = true;
        }
        continue;
      }

      if (Enchants.ELEMENT_DAMAGES.has(name)) {
        if (!hasAtkStat) {
          score += Enchants.WEIGHTS._공격력 * value;
          hasAtkStat = true;
        }
        continue;
      }

      // 나머지는 기본 가중치 계산
      if (Enchants.WEIGHTS[name] !== undefined) {
        score += Enchants.WEIGHTS[name] * value;
      }
    }

    return score;
  }

  static scoreEquipmentEnchant(equip) {
    const status = equip?.enchant?.status || [];
    return this.scoreStatus(status);
  }

  // 특정 아이템의 주어진 upgrade(기본 2) 데이터만 뽑아 candidate 생성
  static candidateFromItemForSlot(item, slot, targetUpgrade = 2) {
    const enchArr = item?.cardInfo?.enchant || [];
    if (!enchArr.length) return null;

    // 1) targetUpgrade 일치하는 엔트리 우선
    let chosen = enchArr.find((e) => (e.upgrade ?? 0) === targetUpgrade);
    // 2) 없으면 upgrade 최댓값 사용
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
      score: this.scoreStatus(status),
      rarity: item.itemRarity,
    };
  }

  // ✅ 슬롯 후보를 “풀업(2/2)만”으로 구성
  static getMaxUpgradeCandidatesForSlot(slotId, targetUpgrade = 2) {
    const { enchants } = this.loadEnchantCatalog();
    const out = [];
    for (const item of enchants) {
      const slots = item?.cardInfo?.slots || [];
      for (const slot of slots) {
        if (slot.slotId !== slotId) continue;
        const cand = this.candidateFromItemForSlot(item, slot, targetUpgrade);
        if (cand) out.push(cand);
      }
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  // 기존 API도 유지하지만 내부에서 풀업만 사용
  static evaluateEnchantForEquipment(equip, limit = 3) {
    const slotId = equip?.slotId;
    const currentScore = this.scoreEquipmentEnchant(equip);
    const candidates = this.getMaxUpgradeCandidatesForSlot(slotId, 2); // 풀업
    const better = candidates
      .filter((c) => c.score > currentScore)
      .slice(0, Math.max(0, Number(limit) || 3));
    return {
      slotId,
      slotName: equip?.slotName,
      equippedItemName: equip?.itemName,
      currentEnchantScore: currentScore,
      currentEnchantStatus: equip?.enchant?.status || [],
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
