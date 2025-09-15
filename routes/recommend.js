// routes/recommend.js
const DfApi = require("../services/df_api");
const Enchants = require("../services/enchants");
const Optimizer = require("../services/optimizer");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

// 캐시 디렉토리 설정
const CACHE_DIR = path.join(__dirname, "../cache/items");

// 캐시 디렉토리 생성
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

module.exports = async function (fastify) {
  fastify.get("/image", async (request, reply) => {
    try {
      const { type, server, id, zoom } = request.query || {};

      if (!type || !id) {
        return reply.code(400).send({ error: "Missing param: id or type" });
      }

      if (type === "char" && !server) {
        return reply.code(400).send({ error: "Missing param: server" });
      }

      let url = "";
      let filePath = null;

      if (type === "item") {
        // 파일명을 안전하게 처리 (특수문자 제거)
        const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
        filePath = path.join(CACHE_DIR, `${safeId}.png`);

        // 캐시된 파일이 있는지 확인
        if (fs.existsSync(filePath)) {
          // 캐시된 파일 반환
          const stats = fs.statSync(filePath);

          reply.header("Access-Control-Allow-Origin", "*");
          reply.header("Cache-Control", "public, max-age=3600, s-maxage=3600");
          reply.header("Content-Type", "image/png");
          reply.header("Content-Length", stats.size);

          const stream = fs.createReadStream(filePath);
          return reply.send(stream);
        }

        url = `https://img-api.neople.co.kr/df/items/${encodeURIComponent(id)}`;
      }

      if (type === "char") {
        url =
          `https://img-api.neople.co.kr/df/servers/${encodeURIComponent(
            server
          )}` +
          `/characters/${encodeURIComponent(id)}` +
          (zoom ? `?zoom=${encodeURIComponent(zoom)}` : "");
        console.log(url);
      }

      const upstream = await axios.get(url, {
        responseType: "stream",
        headers: { "User-Agent": "dnf_growth_recommender/1.0" },
      });

      // CORS/캐시/컨텐츠 타입
      reply.header("Access-Control-Allow-Origin", "*");
      reply.header("Cache-Control", "public, max-age=3600, s-maxage=3600");
      if (upstream.headers["content-type"]) {
        reply.header("Content-Type", upstream.headers["content-type"]);
      }
      if (upstream.headers.etag) reply.header("ETag", upstream.headers.etag);

      // type이 item인 경우 파일시스템에 저장
      if (type === "item" && filePath) {
        const writeStream = fs.createWriteStream(filePath);

        // 스트림을 파일에 저장하면서 클라이언트에도 전송
        upstream.data.pipe(writeStream);

        // 에러 핸들링
        writeStream.on("error", (err) => {
          console.error("File write error:", err);
          // 파일 저장 실패해도 응답은 계속 진행
        });
      }

      return reply.send(upstream.data); // ✅ 스트리밍 그대로 전송
    } catch (err) {
      const status = err.response?.status ?? 502;
      return reply.code(status).send({
        error: "Upstream fetch failed",
        status,
      });
    }
  });

  //
  fastify.get("/recommend", async (request, reply) => {
    try {
      const { server, characterId, name, gold, top, limit, sortMode } =
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

      const bufferList = [
        "眞 뮤즈",
        "眞 패러메딕",
        "眞 인챈트리스",
        "眞 크루세이더",
      ];

      // 1) 캐릭터 식별
      let cid = characterId;
      if (!cid) {
        const found = await DfApi.findCharacter(server, name);

        if (!found?.characterId)
          return reply.status(404).send({ error: "character not found" });
        //  지금 버전에선 버퍼는 제외
        const getJobGrowName = found.raw.jobGrowName;

        const characterIsBuffer = bufferList.includes(getJobGrowName);
        if (characterIsBuffer)
          return reply.status(404).send({ error: "input character is buffer" });

        cid = found.characterId;
      }

      // 1) 캐릭터 상태 조회
      const charStatus = await DfApi.getCharacterStatus(server, cid);

      // 2) 장비 조회
      const equipObj = await DfApi.getEquipment(server, cid);
      const equipment = Array.isArray(equipObj?.equipment)
        ? equipObj.equipment
        : [];

      // 3) 최고 속강 타입(예: "화속성강화") 추출
      const filterElemKey = Enchants.pickTopElementKeyFromStatus(
        charStatus?.status || []
      );

      // 4) 평가 호출 시 필터 주입 (모속강 카드는 내부에서 자동 포함됨)
      const evals = Enchants.evaluateAllEquipment(equipment, safeTopN, {
        filterElemKey,
      });

      // 4) 카드만 필터
      // const cardOnly = evals.map((slot) => ({
      //   ...slot,
      //   recommended: (slot.recommended || []).filter((r) =>
      //     (r.itemName || "").includes("카드")
      //   ),
      // }))
      // .filter((slot) => slot.recommended.length > 0);

      const cardOnly = evals.map((slot) => ({
        ...slot,
        recommended: (slot.recommended || []).filter((r) =>
          (r.itemName || "").includes("카드")
        ),
      }));

      // 5) 가격 조회
      const recItemIds = new Set();
      for (const slot of cardOnly)
        for (const r of slot.recommended)
          if (r?.itemId) recItemIds.add(r.itemId);

      const priceMapForRecommend = await Optimizer.fetchPricesByItemId([
        ...recItemIds,
      ]);

      // console.log(priceMapForRecommend);

      // 6) 가격 주입 + 무가/누락 제거 (recommended.currentStats 사용 안 함)
      const addRecommendedEquipObj = cardOnly.map((slot) => {
        const withPrice = slot.recommended
          .map((r) => {
            const price = priceMapForRecommend.get(r.itemId) ?? null;
            return {
              ...r, // itemId, itemName, slotId, slotName, upgrade, rarity, score, recStats, diff
              price, // { lowestPrice, ... }
            };
          })
          .filter(
            (r) =>
              r.price &&
              Number.isFinite(r.price.lowestPrice) &&
              r.price.lowestPrice > 0
          );

        // 가격 필터 후 점수 기준 재정렬
        withPrice.sort((a, b) => b.score - a.score);

        return {
          slotId: slot.slotId,
          slotName: slot.slotName,
          equippedItemId: slot.equippedItemId,
          equippedItemName: slot.equippedItemName,
          currentStats: slot.currentStats, // ✅ 슬롯에만 유지
          recommended: withPrice, // ✅ 항목에는 currentStats 없음
        };
      });
      // .filter((slot) => slot.recommended.length > 0);

      const upgradeNeededSlots = addRecommendedEquipObj.filter(
        (obj) => obj.recommended.length > 0
      );

      const enchantRecommendationsObj = Object.fromEntries(
        addRecommendedEquipObj.map((s) => [
          s.slotId,
          {
            slotId: s.slotId,
            slotName: s.slotName,
            equippedItemId: s.equippedItemId,
            equippedItemName: s.equippedItemName,
            currentStats: s.currentStats,
            recommended: s.recommended,
          },
        ])
      );

      const response = {
        character: pickCharMeta(equipObj),
        summary: {
          totalSlots: equipment.length,
          upgradeNeededSlots: upgradeNeededSlots.length, // 추천 있는 슬롯 수만 집계

          recommendedPerSlot: safeTopN,
        },
        enchantRecommendations: enchantRecommendationsObj, // price: {lowestPrice, ...}, score: Δ×가중치
      };

      // 7) 예산 플랜(MCKP) — Δ점수와 가격만으로 구성
      const budget = gold !== undefined ? Number(gold) : null;
      if (budget !== null) {
        if (!Number.isFinite(budget) || budget <= 0) {
          return reply
            .status(400)
            .send({ error: "gold must be positive number" });
        }

        // slotMap: Map<slotId, Array<candidate>>
        const slotMap = new Map();
        for (const slot of upgradeNeededSlots) {
          const cands = slot.recommended
            .map((r) => ({
              slotId: slot.slotId,
              slotName: slot.slotName,
              equippedItemName: slot.equippedItemName,
              itemId: r.itemId,
              itemName: r.itemName,
              upgrade: r.upgrade, // 풀업
              price: r.price, // {lowestPrice, ...}
              deltaScore: r.score, // Δ×가중치 점수
              baseScore: 0, // 베이스 스코어 개념 삭제
              candidateScore: r.score, // 호환 필드(있으면 쓰는 외부 로직 대비)
              status: r.recStats, // 추천 스탯(합산 맵)
              rarity: r.rarity,
            }))
            .sort((a, b) => b.deltaScore - a.deltaScore)
            .slice(0, Number(process.env.TOP_DELTA_PER_SLOT ?? 8));
          slotMap.set(slot.slotId, cands);
        }

        const PRICE_UNIT = Number(process.env.PRICE_UNIT ?? 100000);
        const planRes = Optimizer.selectByBudgetMCKP(
          slotMap,
          budget,
          PRICE_UNIT,
          sortMode
        );

        response.budget = budget;
        response.plan = {
          spent: planRes.spent,
          remain: planRes.remain,
          increaseStats: planRes.chosen.reduce((acc, cur) => {
            const rec = enchantRecommendationsObj[cur.slotId];
            if (!rec || !rec.currentStats) return acc;

            const before = rec.currentStats; // 현재 장착중
            const after = cur.status; // 추천된 것

            // 속성강화 통합 함수
            const consolidateElementEnhancement = (stats) => {
              const consolidated = { ...stats };
              let elementEnhValue = 0;

              // 개별 속성강화 중 첫 번째 값 사용 (여러 개 있어도 1개만 적용)
              for (const key of Enchants.ELEMENT_ENH_KEYS) {
                if (consolidated[key]) {
                  elementEnhValue = consolidated[key];
                  delete consolidated[key];
                  break; // 첫 번째 값만 사용하고 종료
                }
              }

              // 모든속성강화가 있으면 그 값 사용 (개별 속성강화보다 우선)
              if (consolidated["모든속성강화"]) {
                elementEnhValue = consolidated["모든속성강화"];
                delete consolidated["모든속성강화"];
              }

              // 속성강화 값이 있으면 추가
              if (elementEnhValue > 0) {
                consolidated["속성강화"] = elementEnhValue;
              }

              return consolidated;
            };

            // before와 after 모두 속성강화 통합
            const consolidatedBefore = consolidateElementEnhancement(before);
            const consolidatedAfter = consolidateElementEnhancement(after);

            Object.entries(consolidatedAfter).forEach(([k, v]) => {
              if (k === "모험가명성") return; // 🚫 합산에서 제외
              const current = consolidatedBefore[k] || 0;
              const delta = v - current;
              if (delta !== 0) {
                acc[k] = (acc[k] || 0) + delta;
              }
            });

            return acc;
          }, {}),
          chosen: planRes.chosen.map((x) => ({
            slotId: x.slotId,
            slotName: x.slotName,
            equippedItemName: x.equippedItemName,
            itemId: x.itemId,
            itemName: x.itemName,
            price: x.price, // {lowestPrice, ...}
            score: x.deltaScore, // 표시용
            baseScore: 0,
            deltaScore: x.deltaScore,
            efficiency:
              x.price && x.price.lowestPrice
                ? x.deltaScore / x.price.lowestPrice
                : null,
            status: x.status, // 추천 스탯(합산 맵)
            rarity: x.rarity,
          })),
          totalDelta: planRes.totalDelta,
        };

        const flattened = Array.from(slotMap.values()).flat();
        response.bestPerSlot = summarizeBestPerSlot(flattened);
      }

      // if (!!gold) {
      //   return reply.send(response.plan);
      // }
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
  const out = {};
  for (const x of best.values()) {
    out[x.slotId] = {
      slotId: x.slotId,
      slotName: x.slotName,
      itemId: x.itemId,
      itemName: x.itemName,
      upgrade: x.upgrade, // 풀업
      price: x.price, // { lowestPrice, ... }
      deltaScore: x.deltaScore,
      status: x.status,
      efficiency:
        x.price && x.price.lowestPrice
          ? x.deltaScore / x.price.lowestPrice
          : null,
    };
  }
  return out;
}
