// services/buffer_enchants.js
const fs = require("fs");
const path = require("path");
const DefaultEnchants = require("./abstract_enchants");

class BufferEnchants extends DefaultEnchants {
  // 버퍼 스킬 강화 가중치
  static SKILL_WEIGHTS = {
    // 직업별 주요 버퍼 스킬 (스킬 레벨당 점수)
    // TODO :
    awakening: 23.5, // 각성 패시브 (1~2각)
    default: 15.5, // 전직 패시브
  };

  static SKILL_TYPES = {
    // 크루세이더(여) - 0c1b401bb09241570d364420b3ba3fd7
    "1dad88963abdc96b091fcab185a8820d": "awakening_passive", // 신실한 열정
    "78bd107acd474518b606be1e4fd38239": "default", // 계시 : 아리아

    // 크루세이더(남) - f6a4ad30555b99b499c07835f87ce522
    "4f2e001e9a19eb7bae50ad1840dfb329": "awakening_passive", // 신념의 오라 (1각)
    "2c9d9a36c8401bddff6cdb80fab8dc24": "default", // 수호의 은총

    // 인챈트리스 - 3909d0b188e9c95311399f776e331da5
    "0dbdeaf846356f8b9380f8fbb8e97377": "awakening_passive", // 소악마 (1각)
    "8d8981a94b8bdd4e3ffad5bc05042080": "default", // 퍼페티어

    // 뮤즈 - b9cb48777665de22c006fabaf9a560b3
    de3fea2d65c597f4d55c70a02b97fc79: "awakening_passive", // 유명세 (1각)
    "0ed3148658fe37b3336ccb718dc0fdb0": "default", // 센세이션

    // 패러메딕 - 944b9aab492c15a8474f96947ceeb9e4
    a8574a8efa365e8e46e805a6e1d7bfef: "awakening_passive", // apius::대응체계(); (1각)
    "6235960237fdb1b77f2c82b33614dcf4": "default", // apius::전장정보()
  };

  // 스탯 가중치 (버퍼용)
  static WEIGHTS = {
    _능력치: 1,
    캐스트속도: 0,
    "모험가 명성": 0,
    // 힘: 1,
    // 지능: 1,
    // 체력: 1,
    // 정신력: 1,
  };

  static loadBufferEnchantCatalog() {
    const raw = this.readJSONSafe(this.DATA_FILE, { bufferEnchants: [] });
    if (Array.isArray(raw)) return { bufferEnchants: raw };
    return {
      bufferEnchants: Array.isArray(raw.bufferEnchants)
        ? raw.bufferEnchants
        : [],
    };
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

  static isAbilityStatKey(key) {
    const k = this.normalizeName(key);
    return k === "힘" || k === "지능" || k === "정신력" || k === "체력";
  }

  // 딜러와 동일한 스탯 처리 메서드 추가
  static weightForStatKey(key) {
    const k = this.normalizeName(key);
    if (this.isAbilityStatKey(k)) return this.WEIGHTS._능력치;
    if (k === "캐스트속도") return this.WEIGHTS.캐스트속도 ?? 0;
    if (k === "모험가명성" || k === "모험가 명성") return 0;
    return this.WEIGHTS[key] ?? 0;
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

  // 스킬 이름으로 타입 판별 (패턴 매칭) - 사용 안 함, 삭제 예정
  static getSkillTypeByName(skillName) {
    // SKILL_TYPE에 없는 스킬은 모두 default로 처리
    return "default";
  }

  // -------- diff calculation --------
  // diffStatusArrays 수정 - 딜러와 유사한 구조로
  static diffStatusArrays(currentStatus = [], recStatus = []) {
    const curStats = this.toStatMap(currentStatus);
    const recStats = this.toStatMap(recStatus);

    const byStat = {};
    const keys = new Set([...Object.keys(curStats), ...Object.keys(recStats)]);

    // 능력치 중 최대값 1개만 선택
    let bestAbility = { key: null, delta: 0 };

    for (const k of keys) {
      const nk = this.normalizeName(k);
      if (nk === "모험가명성") continue;

      const c = Number(curStats[k] || 0);
      const r = Number(recStats[k] || 0);
      if (!c && !r) continue;

      const delta = r - c;
      byStat[k] = { current: c, recommended: r, delta };

      // 능력치인 경우 최대값 추적
      if (this.isAbilityStatKey(nk)) {
        if (bestAbility.key === null || delta > bestAbility.delta) {
          bestAbility = { key: k, delta };
        }
      }
    }

    // 점수 계산
    const abilityW = this.WEIGHTS._능력치 ?? 1;
    const abilityScore = abilityW * (bestAbility.delta || 0);

    // 나머지 스탯 점수 계산
    let othersScore = 0;
    for (const [k, v] of Object.entries(byStat)) {
      const nk = this.normalizeName(k);
      if (this.isAbilityStatKey(nk)) continue; // 능력치는 이미 처리됨

      const w = this.weightForStatKey(k);
      if (w) othersScore += w * (v.delta || 0);
    }

    const statScore = abilityScore + othersScore;

    return {
      byStat,
      meta: {
        statScore,
        deltaScore: statScore, // 딜러와 호환성을 위해 추가
      },
    };
  }

  // diffSkillArrays는 그대로 유지하되, 반환 형식 통일
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
      let skillType = this.SKILL_TYPES[skillInfo.skillId];

      if (!skillType) {
        skillType = this.getSkillTypeByName(skillInfo.skillName);
      }

      const weight =
        this.SKILL_WEIGHTS[skillType] || this.SKILL_WEIGHTS.default;

      bySkill[key] = {
        jobId: skillInfo.jobId,
        jobName: skillInfo.jobName,
        skillId: skillInfo.skillId,
        skillName: skillInfo.skillName,
        currentLevel: curLevel,
        recommendedLevel: recLevel,
        delta,
        skillType,
        weight,
      };

      totalScore += weight * delta;
    }

    return {
      bySkill,
      meta: {
        skillScore: totalScore,
      },
    };
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

    console.log(status);
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
  // evaluateBufferEnchantForEquipment 수정
  static evaluateBufferEnchantForEquipment(equip, limit = 3, ctx = {}) {
    const slotId = equip?.slotId;
    const targetJobId = ctx.jobId || null;
    const currentStats = this.toStatMap(equip?.enchant?.status || []);
    const currentSkills = this.toSkillMap(
      equip?.enchant?.reinforceSkill || [],
      targetJobId
    );
    const candidates = this.getMaxUpgradeCandidatesForSlot(slotId);

    const enriched = [];
    for (const c of candidates) {
      const recStats = this.toStatMap(c.status);
      const recSkills = this.toSkillMap(c.reinforceSkill, targetJobId);

      // 스탯 diff 계산
      const statDiff = this.diffStatusArrays(
        equip?.enchant?.status || [],
        c.status
      );

      // 스킬 diff 계산
      const skillDiff = this.diffSkillArrays(
        equip?.enchant?.reinforceSkill || [],
        c.reinforceSkill,
        targetJobId
      );

      const totalScore =
        (statDiff.meta?.deltaScore || 0) + (skillDiff.meta?.skillScore || 0);

      // recStats에 스킬 정보 병합
      const recStatsWithSkills = {
        ...recStats,
        // 스킬 정보를 별도 필드로 추가
        _skills: recSkills,
        // 또는 스킬을 스탯처럼 플랫하게 추가
        // ...Object.fromEntries(
        //   Object.entries(recSkills).map(([key, skill]) => [
        //     `skill_${skill.skillName}`,
        //     skill.level
        //   ])
        // )
      };

      enriched.push({
        itemId: c.itemId,
        itemName: c.itemName,
        slotId: c.slotId,
        slotName: c.slotName,
        upgrade: c.upgrade,
        rarity: c.rarity,
        score: totalScore,
        recStats: recStatsWithSkills, // 스킬 정보가 포함된 recStats
        diff: {
          byStat: statDiff.byStat,
          bySkill: skillDiff.bySkill,
          meta: {
            statScore: statDiff.meta?.deltaScore || 0,
            skillScore: skillDiff.meta?.skillScore || 0,
            deltaScore: totalScore,
          },
        },
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
      currentStats,
      currentSkills,
      recommended: better,
    };
  }
  // }
  static evaluateAllEquipment(equipmentList = [], limit = 3, ctx = {}) {
    return equipmentList.map((eq) =>
      this.evaluateBufferEnchantForEquipment(eq, limit, ctx)
    );
  }
}

module.exports = BufferEnchants;
