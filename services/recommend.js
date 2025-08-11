// class Recommend {
//   /**
//    * identifyCandidates(equipment)
//    * - equipment: 던파 장비 정보
//    * - Returns: [{ id, name, slot, note, exampleItemId }]
//    *
//    * 이 함수는 '내실 후보'를 식별합니다.
//    * MVP에서는 고정 후보 목록 + 비어있는 슬롯 체크로 구현.
//    */
//   static identifyCandidates(equipment) {
//     const candidates = [];

//     // 칭호
//     const title = equipment.title || null;
//     if (!title || title.isDefault) {
//       candidates.push({
//         id: "title_basic",
//         name: "칭호 (추천 에픽칭호)",
//         slot: "title",
//         exampleItemId: "ITEM_ID_TITLE_EPIC",
//         price: null,
//         estDpsGain: null,
//       });
//     }

//     // 크리쳐
//     const creature = equipment.creature || null;
//     if (!creature || creature.isDefault) {
//       candidates.push({
//         id: "creature_epic",
//         name: "에픽 크리쳐",
//         slot: "creature",
//         exampleItemId: "ITEM_ID_CREATURE_EPIC",
//         price: null,
//         estDpsGain: null,
//       });
//     }

//     // 오라, 마법부여, 엠블렘 등
//     candidates.push({
//       id: "enchant_magic",
//       name: "마법부여(기본->완성)",
//       slot: "enchant",
//       exampleItemId: "ITEM_ID_ENCHANT_FULL",
//       price: null,
//       estDpsGain: null,
//     });

//     return candidates;
//   }

//   /**
//    * populatePrices(candidates, dfApi)
//    * - candidates: 배열
//    * - dfApi: df_api 모듈 참조
//    * -> 각 candidate에 price 필드 채움 (lowestPrice)
//    */
//   static async populatePrices(candidates, dfApi) {
//     for (const c of candidates) {
//       if (!c.exampleItemId) {
//         c.price = Infinity;
//         continue;
//       }
//       const priceInfo = await dfApi
//         .getAuctionPrice(c.exampleItemId)
//         .catch(() => null);

//       console.log("priceInfo", priceInfo);
//       c.price = priceInfo ? priceInfo.lowestPrice || null : null;

//       // 개발 중 기본값
//       if (!c.price) c.price = 10_000_000;
//     }
//   }

//   /**
//    * evaluateCandidates(candidates, equipment, dondam, baseDps)
//    * - candidates: with price
//    * - returns: evaluated list with estDpsGain, efficiency
//    */
//   static async evaluateCandidates(candidates, equipment, dondam, baseDps) {
//     const results = [];
//     for (const c of candidates) {
//       // 가상 세팅
//       const newEquip = this.#applyCandidateToEquipment(c, equipment);

//       // DPS 계산
//       const newDps = await dondam.calcDpsFromEquipment(newEquip).catch(() => {
//         return baseDps * (1 + 0.03);
//       });

//       const dpsGain = newDps - baseDps;
//       const gainRatio = dpsGain / baseDps;
//       const efficiency = gainRatio / (c.price || 1);

//       results.push({
//         ...c,
//         newDps,
//         dpsGain,
//         gainRatio,
//         efficiency,
//       });
//     }
//     return results;
//   }

//   /**
//    * selectByBudget(evaluatedCandidates, budget)
//    * - efficiency 내림차순 정렬 후 예산 범위 내에서 선택
//    */
//   static selectByBudget(evaluated, budget) {
//     const sorted = evaluated
//       .slice()
//       .sort((a, b) => b.efficiency - a.efficiency);
//     const selected = [];
//     let remain = budget;

//     for (const item of sorted) {
//       const price = item.price || Infinity;
//       if (price <= remain) {
//         selected.push({
//           id: item.id,
//           name: item.name,
//           price,
//           gainRatio: item.gainRatio,
//           newDps: item.newDps,
//         });
//         remain -= price;
//       }
//     }

//     return {
//       budget,
//       spent: budget - remain,
//       remain,
//       items: selected,
//     };
//   }

//   /**
//    * 내부 전용: candidate 적용된 장비 복제
//    */
//   static #applyCandidateToEquipment(candidate, equipment) {
//     const copy = JSON.parse(JSON.stringify(equipment || {}));
//     copy._appliedCandidate = candidate.id;
//     // 실제로는 슬롯에 exampleItemId 적용 필요
//     return copy;
//   }
// }

// module.exports = Recommend;
