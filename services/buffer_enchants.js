// services/buffer_enchants.js
const fs = require("fs");
const path = require("path");
const DefaultEnchants = require("./abstract_enchants");

class BufferEnchants extends DefaultEnchants {
  //   static DATA_FILE = path.resolve(
  //     __dirname,
  //     "../data/recommend_item_details.json"
  //   );

  // 버퍼 스킬 강화 가중치
  static SKILL_WEIGHTS = {
    // 직업별 주요 버퍼 스킬 (스킬 레벨당 점수)
    default: 50, // 기본 스킬 레벨당 점수
  };

  // 스탯 가중치 (버퍼용)
  static WEIGHTS = {
    힘: 1,
    지능: 1,
    체력: 1,
    정신력: 1,
    // "물리 크리티컬 히트": 2,
    // "마법 크리티컬 히트": 2,
    // "모험가 명성": 0,
  };

  // -------- file I/O --------
  //   static readJSONSafe(fp, fb) {
  //     try {
  //       if (!fs.existsSync(fp)) return fb;
  //       return JSON.parse(fs.readFileSync(fp, "utf-8"));
  //     } catch {
  //       return fb;
  //     }
  //   }

  static loadBufferEnchantCatalog() {
    const raw = this.readJSONSafe(this.DATA_FILE, { bufferEnchants: [] });
    if (Array.isArray(raw)) return { bufferEnchants: raw };
    return {
      bufferEnchants: Array.isArray(raw.bufferEnchants)
        ? raw.bufferEnchants
        : [],
    };
  }

  // -------- normalize & map --------
  //   static normalizeValue(v) {
  //     if (typeof v === "number") return v;
  //     if (typeof v === "string") {
  //       const s = v.trim().replace(/,/g, "");
  //       const m = s.match(/-?\d+(\.\d+)?/);
  //       if (m) return parseFloat(m[0]);
  //     }
  //     return NaN;
  //   }

  //   static normalizeName(name) {
  //     return String(name || "")
  //       .trim()
  //       .replace(/\s+/g, "");
  //   }

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

  static toSkillMap(reinforceSkillList = [], targetJobId = null) {
    const map = {};
    for (const jobSkills of reinforceSkillList || []) {
      // 특정 직업만 필터링 (targetJobId가 있는 경우)
      if (targetJobId && jobSkills.jobId !== targetJobId) continue;

      for (const skill of jobSkills.skills || []) {
        const key = `${jobSkills.jobId}:${skill.skillId}`;
        const name = skill.name;
        const value = this.normalizeValue(skill.value);
        if (!Number.isFinite(value)) continue;

        map[key] = {
          jobId: jobSkills.jobId,
          jobName: jobSkills.jobName,
          skillId: skill.skillId,
          skillName: name,
          level: value,
        };
      }
    }
    return map;
  }

  // -------- diff calculation --------
  static diffStatusArrays(currentStatus = [], recStatus = []) {
    const curStats = this.toStatMap(currentStatus);
    const recStats = this.toStatMap(recStatus);

    const byStat = {};
    const keys = new Set([...Object.keys(curStats), ...Object.keys(recStats)]);

    let totalScore = 0;

    for (const k of keys) {
      const nk = this.normalizeName(k);
      if (nk === "모험가명성") continue;

      const c = Number(curStats[k] || 0);
      const r = Number(recStats[k] || 0);
      const delta = r - c;

      if (!c && !r) continue;

      byStat[k] = { current: c, recommended: r, delta };

      const weight = this.WEIGHTS[k] ?? 0;
      totalScore += weight * delta;
    }

    return { byStat, statScore: totalScore };
  }

  static diffSkillArrays(
    currentSkills = [],
    recSkills = [],
    targetJobId = null
  ) {
    const curSkillMap = this.toSkillMap(currentSkills, targetJobId);
    const recSkillMap = this.toSkillMap(recSkills, targetJobId);

    const bySkill = {};
    const keys = new Set([
      ...Object.keys(curSkillMap),
      ...Object.keys(recSkillMap),
    ]);

    let totalScore = 0;

    for (const key of keys) {
      const cur = curSkillMap[key];
      const rec = recSkillMap[key];

      const curLevel = cur ? cur.level : 0;
      const recLevel = rec ? rec.level : 0;
      const delta = recLevel - curLevel;

      if (!curLevel && !recLevel) continue;

      const skillInfo = rec || cur;
      bySkill[key] = {
        jobId: skillInfo.jobId,
        jobName: skillInfo.jobName,
        skillId: skillInfo.skillId,
        skillName: skillInfo.skillName,
        currentLevel: curLevel,
        recommendedLevel: recLevel,
        delta,
      };

      const weight = this.SKILL_WEIGHTS.default;
      totalScore += weight * delta;
    }

    return { bySkill, skillScore: totalScore };
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
    const reinforceSkill = Array.isArray(chosen.reinforceSkill)
      ? chosen.reinforceSkill
      : [];

    return {
      itemId: item.itemId,
      itemName: item.itemName,
      slotId: slot.slotId,
      slotName: slot.slotName,
      upgrade: chosen.upgrade ?? 0,
      status,
      reinforceSkill,
      rarity: item.itemRarity,
    };
  }

  static getMaxUpgradeCandidatesForSlot(slotId) {
    const { bufferEnchants } = this.loadBufferEnchantCatalog();
    const out = [];
    for (const item of bufferEnchants) {
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
  static evaluateBufferEnchantForEquipment(equip, limit = 3, ctx = {}) {
    const slotId = equip?.slotId;
    const targetJobId = ctx.jobId || null;

    const candidates = this.getMaxUpgradeCandidatesForSlot(slotId);

    const enriched = [];
    for (const c of candidates) {
      const statDiff = this.diffStatusArrays(
        equip?.enchant?.status || [],
        c.status
      );

      const skillDiff = this.diffSkillArrays(
        equip?.enchant?.reinforceSkill || [],
        c.reinforceSkill,
        targetJobId
      );

      const totalScore = statDiff.statScore + skillDiff.skillScore;

      enriched.push({
        itemId: c.itemId,
        itemName: c.itemName,
        slotId: c.slotId,
        slotName: c.slotName,
        upgrade: c.upgrade,
        rarity: c.rarity,
        score: totalScore,
        statDiff,
        skillDiff,
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
      currentStats: this.toStatMap(equip?.enchant?.status || []),
      currentSkills: this.toSkillMap(
        equip?.enchant?.reinforceSkill || [],
        targetJobId
      ),
      recommended: better,
    };
  }

  static evaluateAllEquipment(equipmentList = [], limit = 3, ctx = {}) {
    return equipmentList.map((eq) =>
      this.evaluateBufferEnchantForEquipment(eq, limit, ctx)
    );
  }
}

module.exports = BufferEnchants;
