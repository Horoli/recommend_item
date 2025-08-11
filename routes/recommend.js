// routes/recommend.js
const DfApi = require("../services/df_api"); // 네가 export한 객체 사용 (findCharacter/getEquipment/getAuctionLowestPrice 포함)
const Enchants = require("../services/enchants");
const Optimizer = require("../services/optimizer");

module.exports = async function (fastify) {
  fastify.get("/recommend", async (request, reply) => {
    try {
      const { server, characterId, name, gold, top, limit } =
        request.query || {};
      if (!server)
        return reply.status(400).send({ error: "server is required" });
      if (!characterId && !name)
        return reply
          .status(400)
          .send({ error: "characterId or name is required" });

      const topN = Number(top ?? limit ?? process.env.ENCHANT_TOP_DEFAULT ?? 3);
      const safeTopN =
        Number.isFinite(topN) && topN > 0 ? Math.min(topN, 50) : 3;

      // 캐릭터 식별
      let cid = characterId;
      if (!cid) {
        const found = await DfApi.findCharacter(server, name);
        if (!found?.characterId)
          return reply.status(404).send({ error: "character not found" });
        cid = found.characterId;
      }

      // 장비
      const equipObj = await DfApi.getEquipment(server, cid);
      const equipment = Array.isArray(equipObj?.equipment)
        ? equipObj.equipment
        : [];

      // 기본 추천(풀업 스탯) 산출
      const evals = Enchants.evaluateAllEquipment(equipment, safeTopN);
      // 카드만
      const needsRaw = evals
        .map((slot) => ({
          ...slot,
          recommended: (slot.recommended || []).filter((r) =>
            (r.itemName || "").includes("카드")
          ),
        }))
        .filter((slot) => slot.recommended.length > 0);

      // 가격 상세 조회 & 주입 (null 제거)
      const recItemIds = new Set();
      for (const slot of needsRaw)
        for (const r of slot.recommended)
          if (r?.itemId) recItemIds.add(r.itemId);
      const priceMapForRecommend = await Optimizer.fetchPricesByItemId(
        [...recItemIds],
        DfApi,
        Number(process.env.PRICE_LOOKUP_DELAY ?? 50)
      );

      const needs = needsRaw
        .map((slot) => {
          const withPrice = slot.recommended
            .map((r) => ({
              ...r,
              price: priceMapForRecommend.get(r.itemId) ?? null,
            }))
            .filter(
              (r) =>
                r.price &&
                Number.isFinite(r.price.lowestPrice) &&
                r.price.lowestPrice > 0
            );
          return { ...slot, recommended: withPrice };
        })
        .filter((slot) => slot.recommended.length > 0);

      const response = {
        character: pickCharMeta(equipObj),
        summary: {
          totalSlots: equipment.length,
          upgradeNeededSlots: needs.length,
          recommendedPerSlot: safeTopN,
        },
        enchantRecommendations: needs, // price: {lowestPrice, raw}
      };

      // gold 플랜 (MCKP)
      const budget = gold !== undefined ? Number(gold) : null;
      if (budget !== null) {
        if (!Number.isFinite(budget) || budget <= 0) {
          return reply
            .status(400)
            .send({ error: "gold must be positive number" });
        }

        const currentBySlot = new Map();
        for (const eq of equipment) {
          currentBySlot.set(eq.slotId, {
            equip: eq,
            currentScore: Enchants.scoreEquipmentEnchant(eq),
          });
        }

        const slotMap = await Optimizer.buildCandidatesWithPrices(
          equipment,
          currentBySlot,
          Enchants,
          DfApi,
          {
            deltaMin: Number(process.env.DELTA_MIN ?? 50),
            topDeltaPerSlot: Number(process.env.TOP_DELTA_PER_SLOT ?? 8),
            priceLookupDelay: Number(process.env.PRICE_LOOKUP_DELAY ?? 120),
          }
        );

        const PRICE_UNIT = Number(process.env.PRICE_UNIT ?? 100000);
        const planRes = Optimizer.selectByBudgetMCKP(
          slotMap,
          budget,
          PRICE_UNIT
        );

        response.budget = budget;
        response.plan = {
          spent: planRes.spent,
          remain: planRes.remain,
          chosen: planRes.chosen.map((x) => ({
            slotId: x.slotId,
            slotName: x.slotName,
            equippedItemName: x.equippedItemName,
            itemId: x.itemId,
            itemName: x.itemName,
            upgrade: x.upgrade, // 풀업
            price: x.price, // {lowestPrice, raw}
            score: x.score ?? x.candidateScore,
            baseScore: x.baseScore,
            deltaScore: x.deltaScore, // 풀업 기준
            efficiency: x.deltaScore / x.price.lowestPrice,
            status: x.status,
            rarity: x.rarity,
          })),
          totalDelta: planRes.totalDelta,
        };

        const flattened = Array.from(slotMap.values()).flat();
        response.bestPerSlot = summarizeBestPerSlot(flattened);
      }

      return reply.send(response);
    } catch (err) {
      request.log.error(err);
      return reply
        .status(500)
        .send({ error: "internal_error", detail: err.message });
    }
  });
};

// ---- helpers ----
function pickCharMeta(equipObj) {
  return {
    serverId: equipObj.serverId,
    characterId: equipObj.characterId,
    characterName: equipObj.characterName,
    jobName: equipObj.jobName,
    jobGrowName: equipObj.jobGrowName,
    fame: equipObj.fame,
  };
}

function summarizeBestPerSlot(cands) {
  const best = new Map();
  for (const c of cands) {
    const prev = best.get(c.slotId);
    const eNow =
      c.price && c.price.lowestPrice
        ? c.deltaScore / c.price.lowestPrice
        : -Infinity;
    const ePrev =
      prev && prev.price && prev.price.lowestPrice
        ? prev.deltaScore / prev.price.lowestPrice
        : -Infinity;
    if (!prev || eNow > ePrev) best.set(c.slotId, c);
  }
  return Array.from(best.values()).map((x) => ({
    slotId: x.slotId,
    slotName: x.slotName,
    itemId: x.itemId,
    itemName: x.itemName,
    upgrade: x.upgrade, // 풀업
    price: x.price, // {lowestPrice, raw}
    deltaScore: x.deltaScore,
    efficiency:
      x.price && x.price.lowestPrice
        ? x.deltaScore / x.price.lowestPrice
        : null,
  }));
}
