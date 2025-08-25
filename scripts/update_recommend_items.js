// scripts/update_recommend_items.js
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch"); // v2 권장 (v3는 ESM 전용)
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const API_KEY = process.env.DP_API_KEY; // TODO: 실제 키로 교체
const BASE_URL = "https://api.neople.co.kr/df";

const dataDir = path.resolve("../data");
const recommendFile = path.join(dataDir, "recommend.json");
const recommendGetItemsFile = path.join(dataDir, "recommend_get_items.json");
const recommendItemDetailsFile = path.join(
  dataDir,
  "recommend_item_details.json"
);

// ---------- utils ----------
function readJSON(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback ?? null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}
function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function norm(s) {
  return (s ?? "").toString().replace(/[,\s]/g, "").trim();
}

// rows 배열을 itemId 기준으로 dedup
function dedupByItemId(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!r || !r.itemId) continue;
    map.set(r.itemId, r);
  }
  return Array.from(map.values());
}

// details 객체 표준화: { enchants:[], titles:[], creatures:[], auras:[] }
function emptyDetailsObj() {
  return { enchants: [], titles: [], creatures: [], auras: [] };
}
function readDetailsAsObject() {
  const raw = readJSON(recommendItemDetailsFile, null);
  if (!raw) return emptyDetailsObj();

  // 과거: 배열로 저장되어 있던 경우 → enchants로 마이그레이션
  if (Array.isArray(raw)) {
    return { enchants: raw, titles: [], creatures: [], auras: [] };
  }

  const out = emptyDetailsObj();
  if (raw && Array.isArray(raw.enchants)) out.enchants = raw.enchants;
  if (raw && Array.isArray(raw.titles)) out.titles = raw.titles;
  if (raw && Array.isArray(raw.creatures)) out.creatures = raw.creatures;
  if (raw && Array.isArray(raw.auras)) out.auras = raw.auras;
  return out;
}
function writeDetailsObject(obj) {
  const safe = emptyDetailsObj();
  for (const k of Object.keys(safe)) {
    if (Array.isArray(obj?.[k])) safe[k] = obj[k];
  }
  writeJSON(recommendItemDetailsFile, safe);
}

// recommend_get_items.json 표준화: { rows: [ { ...row, category?: 'enchants'|'titles'|'creatures'|'auras' } ] }
function readGetItems() {
  const raw = readJSON(recommendGetItemsFile, { rows: [] });
  const rows = Array.isArray(raw.rows) ? raw.rows : [];
  return { rows };
}
function writeGetItems(rows) {
  writeJSON(recommendGetItemsFile, { rows });
}

// ✅ recommend.json 읽기: { enchants:[], titles:[], creatures:[], auras:[] }
function readRecommend() {
  const raw = readJSON(recommendFile, {
    enchants: [],
    titles: [],
    creatures: [],
    auras: [],
  });

  // 과거 호환: items 키가 남아있으면 enchants로 병합
  const legacyItems = Array.isArray(raw.items) ? raw.items : [];
  const ench = Array.isArray(raw.enchants) ? raw.enchants : [];

  return {
    enchants: [...new Set([...(ench || []), ...legacyItems])],
    titles: Array.isArray(raw.titles) ? raw.titles : [],
    creatures: Array.isArray(raw.creatures) ? raw.creatures : [],
    auras: Array.isArray(raw.auras) ? raw.auras : [],
  };
}

// ---------- logic ----------

// recommend.json의 각 카테고리에서, recommend_get_items.json(rows)에 없는 이름만 추림
function computeMissingNamesByCategory() {
  const rec = readRecommend();
  const getItems = readGetItems();

  const presentNames = new Set(getItems.rows.map((r) => norm(r.itemName)));

  function namesMissing(list) {
    const missing = [];
    for (const name of list) {
      const n = norm(name);
      const isPresent = Array.from(presentNames).some(
        (rowN) => rowN.includes(n) || n.includes(rowN)
      );
      if (!isPresent) missing.push(name);
    }
    return missing;
  }

  return {
    enchants: namesMissing(rec.enchants),
    titles: namesMissing(rec.titles),
    creatures: namesMissing(rec.creatures),
    auras: namesMissing(rec.auras),
    stats: {
      recCounts: {
        enchants: rec.enchants.length,
        titles: rec.titles.length,
        creatures: rec.creatures.length,
        auras: rec.auras.length,
      },
      presentRows: getItems.rows.length,
    },
  };
}

// Step 1: 부족한 이름만 검색 → recommend_get_items.json 갱신(merge), 각 row에 category 부여
async function fetchRecommendItemsOnlyMissing(missingByCat) {
  const getItems = readGetItems();
  const existingRows = getItems.rows;

  const entries = [
    ["enchants", missingByCat.enchants],
    ["titles", missingByCat.titles],
    ["creatures", missingByCat.creatures],
    ["auras", missingByCat.auras],
  ];

  let appended = 0;

  for (const [category, names] of entries) {
    if (!names || names.length === 0) continue;

    for (const itemName of names) {
      const url = `${BASE_URL}/items?itemName=${encodeURIComponent(
        itemName
      )}&wordType=front&limit=30&apikey=${API_KEY}`;
      console.log(url);
      console.log(`🔍 [${category}] 아이템 검색: ${itemName}`);
      const res = await fetch(url);
      if (!res.ok) {
        console.error(
          `❌ [${category}] 검색 실패: ${itemName} (status: ${res.status})`
        );
      } else {
        const data = await res.json();
        if (data.rows && Array.isArray(data.rows) && data.rows.length > 0) {
          for (const row of data.rows) {
            appended++;
            existingRows.push({ ...row, category });
          }
        } else {
          console.warn(`⚠ [${category}] 검색 결과 없음: ${itemName}`);
        }
      }
      // 네오플 API 예의상 3초 대기
      await delay(200);
    }
  }

  const merged = dedupByItemId(existingRows);
  writeGetItems(merged);
  console.log(
    `✅ recommend_get_items.json 갱신 완료 (+${appended} rows, 합계 ${merged.length})`
  );
}

// Step 2: recommend_get_items.json의 itemId 중, 상세에 없는 것만 multi/items로 조회 → { enchants|titles|creatures|auras: [] } 병합
async function fetchItemDetailsOnlyMissing() {
  const getItems = readGetItems();
  const rows = Array.isArray(getItems.rows) ? getItems.rows : [];
  const idToCategory = new Map(rows.map((r) => [r.itemId, r.category])); // category 없을 수도 있음

  const detailsObj = readDetailsAsObject();
  const haveIds = new Set(
    [
      ...detailsObj.enchants.map((d) => d.itemId),
      ...detailsObj.titles.map((d) => d.itemId),
      ...detailsObj.creatures.map((d) => d.itemId),
      ...detailsObj.auras.map((d) => d.itemId),
    ].filter(Boolean)
  );

  const allItemIds = rows.map((r) => r.itemId).filter(Boolean);
  const toFetchIds = allItemIds.filter((id) => !haveIds.has(id));
  if (toFetchIds.length === 0) {
    console.log("✅ 상세 조회할 신규 itemId가 없습니다.");
    return;
  }

  console.log(`📦 상세 조회 대상: ${toFetchIds.length}개 (15개씩 배치 호출)`);

  const newDetails = [];

  for (let i = 0; i < toFetchIds.length; i += 15) {
    const batch = toFetchIds.slice(i, i + 15);
    const url = `${BASE_URL}/multi/items?itemIds=${batch.join(
      ","
    )}&apikey=${API_KEY}`;
    console.log(`  → batch ${i / 15 + 1}: ${batch.length}개`);
    const res = await fetch(url);
    if (!res.ok) {
      console.error(
        `❌ multi/items 조회 실패 (status: ${res.status}) for batch starting ${batch[0]}`
      );
    } else {
      const data = await res.json();
      if (data && Array.isArray(data.rows)) {
        newDetails.push(...data.rows);
      } else if (data && data.rows && typeof data.rows === "object") {
        newDetails.push(...Object.values(data.rows));
      } else {
        console.warn("⚠ 예상치 못한 응답 형식:", data);
      }
    }
    await delay(200);
  }

  const ench = detailsObj.enchants.slice();
  const titl = detailsObj.titles.slice();
  const crea = detailsObj.creatures.slice();
  const aura = detailsObj.auras.slice();

  for (const detail of newDetails) {
    const cat =
      idToCategory.get(detail.itemId) || inferCategoryFromName(detail.itemName);
    switch (cat) {
      case "titles":
        titl.push(detail);
        break;
      case "creatures":
        crea.push(detail);
        break;
      case "auras":
        aura.push(detail);
        break;
      case "enchants":
      default:
        ench.push(detail);
        break;
    }
  }

  const merged = {
    enchants: dedupByItemId(ench),
    titles: dedupByItemId(titl),
    creatures: dedupByItemId(crea),
    auras: dedupByItemId(aura),
  };
  writeDetailsObject(merged);

  const totalBefore =
    detailsObj.enchants.length +
    detailsObj.titles.length +
    detailsObj.creatures.length +
    detailsObj.auras.length;

  const totalAfter =
    merged.enchants.length +
    merged.titles.length +
    merged.creatures.length +
    merged.auras.length;

  console.log(
    `✅ recommend_item_details.json 갱신 완료 (총 ${totalBefore} → ${totalAfter})`
  );
}

// category 추론(백업): itemName 키워드로 대충 분류, 실패 시 'enchants'
function inferCategoryFromName(name) {
  const n = (name || "").toLowerCase();
  if (n.includes("칭호")) return "titles";
  if (n.includes("크리쳐") || n.includes("크리처")) return "creatures";
  if (n.includes("오라")) return "auras";
  // '보주', '카드' 등은 enchants로
  return "enchants";
}

// ---------- main ----------
(async () => {
  console.log("🚀 추천 아이템 동기화 시작");

  const missingByCat = computeMissingNamesByCategory();
  console.log(
    `📊 recommend.json counts → enchants:${missingByCat.stats.recCounts.enchants}, titles:${missingByCat.stats.recCounts.titles}, creatures:${missingByCat.stats.recCounts.creatures}, auras:${missingByCat.stats.recCounts.auras} | present rows: ${missingByCat.stats.presentRows}`
  );
  console.log(
    `🧩 부족한 이름 → enchants:${missingByCat.enchants.length}, titles:${missingByCat.titles.length}, creatures:${missingByCat.creatures.length}, auras:${missingByCat.auras.length}`
  );

  await fetchRecommendItemsOnlyMissing(missingByCat);
  await fetchItemDetailsOnlyMissing();

  console.log("🎯 완료");
})();
