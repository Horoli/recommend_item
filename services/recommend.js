/**
 * identifyCandidates(equipment)
 * - equipment: 던파 장비 정보
 * - Returns: [{ id, name, slot, note, exampleItemId }]
 *
 * 이 함수는 '내실 후보'를 식별합니다. MVP에서는 고정 후보 목록 + 비어있는 슬롯 체크로 구현.
 */
function identifyCandidates(equipment) {
  // 예시: 장비 내에서 칭호/크리쳐/오라/엠블렘/마법부여 슬롯 존재 여부 확인
  // 실제 응답 포맷에 맞춰 검사 필요
  const candidates = [];

  // 예: 칭호가 없거나 기본 칭호면 후보 추가
  const title = equipment.title || null;
  if (!title || title.isDefault) {
    candidates.push({
      id: "title_basic",
      name: "칭호 (추천 에픽칭호)",
      slot: "title",
      exampleItemId: "ITEM_ID_TITLE_EPIC",
      price: null,
      estDpsGain: null,
    });
  }

  // 크리쳐 예시
  const creature = equipment.creature || null;
  if (!creature || creature.isDefault) {
    candidates.push({
      id: "creature_epic",
      name: "에픽 크리쳐",
      slot: "creature",
      exampleItemId: "ITEM_ID_CREATURE_EPIC",
      price: null,
      estDpsGain: null,
    });
  }

  // 오라, 마법부여, 엠블렘 등도 유사하게...
  candidates.push({
    id: "enchant_magic",
    name: "마법부여(기본->완성)",
    slot: "enchant",
    exampleItemId: "ITEM_ID_ENCHANT_FULL",
    price: null,
    estDpsGain: null,
  });

  return candidates;
}

/**
 * populatePrices(candidates, dfApi)
 * - candidates: 배열 (위)
 * - dfApi: df_api 모듈 참조
 * -> 각 candidate에 price 필드 채움 (lowestPrice)
 */
async function populatePrices(candidates, dfApi) {
  for (const c of candidates) {
    if (!c.exampleItemId) {
      c.price = Infinity;
      continue;
    }
    const priceInfo = await dfApi
      .getAuctionPrice(c.exampleItemId)
      .catch((e) => null);

    console.log("priceInfo", priceInfo);
    c.price = priceInfo ? priceInfo.lowestPrice || null : null;
    // 개발 중엔 price가 null이면 임의값 지정해도 됨
    if (!c.price) c.price = 10_000_000; // 기본값: 1,000만
  }
}

/**
 * evaluateCandidates(candidates, equipment, dondam, baseDps)
 * - candidates: with price
 * - returns: evaluated list with estDpsGain, efficiency
 */
async function evaluateCandidates(candidates, equipment, dondam, baseDps) {
  const results = [];
  for (const c of candidates) {
    // 1) 장비 복제 후 해당 내실을 적용한 가상 세팅 생성
    const newEquip = applyCandidateToEquipment(c, equipment);

    // 2) 던담으로 DPS 계산
    const newDps = await dondam.calcDpsFromEquipment(newEquip).catch((e) => {
      // 실패 시 추정치 사용
      return baseDps * (1 + 0.03); // 기본 3% 상승 가정
    });

    const dpsGain = newDps - baseDps;
    const gainRatio = dpsGain / baseDps; // 예: 0.05 => +5%
    const efficiency = gainRatio / (c.price || 1); // (증가율) / 가격

    results.push({
      ...c,
      newDps,
      dpsGain,
      gainRatio,
      efficiency,
    });
  }
  return results;
}

function applyCandidateToEquipment(candidate, equipment) {
  // 아주 단순하게 equipment 복제 후 note 삽입
  const copy = JSON.parse(JSON.stringify(equipment || {}));
  copy._appliedCandidate = candidate.id;
  // 실제로는 장비 슬롯/아이템 id를 candidate.exampleItemId로 교체해야함
  return copy;
}

/**
 * selectByBudget(evaluatedCandidates, budget)
 * - 단순 그리디: efficiency 내림차순으로 골라 budget 허용하면 포함
 * - 반환: 선택된 항목 배열 + 요약
 */
function selectByBudget(evaluated, budget) {
  const sorted = evaluated.slice().sort((a, b) => b.efficiency - a.efficiency);
  const selected = [];
  let remain = budget;
  for (const item of sorted) {
    const price = item.price || Infinity;
    if (price <= remain) {
      selected.push({
        id: item.id,
        name: item.name,
        price,
        gainRatio: item.gainRatio,
        newDps: item.newDps,
      });
      remain -= price;
    }
  }
  return {
    budget,
    spent: budget - remain,
    remain,
    items: selected,
  };
}

module.exports = {
  identifyCandidates,
  populatePrices,
  evaluateCandidates,
  selectByBudget,
};
