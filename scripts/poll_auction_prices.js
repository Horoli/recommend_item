// scripts/poll_auction_prices.js
const fs = require("fs/promises");
const fssync = require("fs");
const path = require("path");
const axios = require("axios");
const pLimit = require("p-limit");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const API_KEY = process.env.DP_API_KEY;
if (!API_KEY) {
  console.error("❌ DP_API_KEY 가 .env에 설정되어 있지 않습니다.");
  process.exit(1);
}

const BASE_URL = "https://api.neople.co.kr/df";
const INPUT_FILE = path.resolve(__dirname, "../data/recommend_get_items.json");
const OUT_DIR = path.resolve(__dirname, "../data/auction_prices");
const OUT_FILE = path.join(OUT_DIR, "latest.json");
const LOCK_FILE = path.join(OUT_DIR, ".poller.lock");

const CONCURRENCY = Number(process.env.POLL_CONCURRENCY ?? 5);
const MAX_RETRIES = Number(process.env.POLL_RETRIES ?? 3);
const SLEEP_MS_BETWEEN = Number(process.env.POLL_SLEEP_MS ?? 120);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function nowKST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}
function isoKST(d = nowKST()) {
  return `${d.toISOString().replace("Z", "")}+09:00`;
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function readItems() {
  const raw = await fs.readFile(INPUT_FILE, "utf-8");
  const json = JSON.parse(raw);
  const rows = Array.isArray(json.rows) ? json.rows : [];
  const map = new Map();
  for (const r of rows) if (r?.itemId) map.set(r.itemId, r);
  return Array.from(map.values());
}

async function fetchLowestPrice(itemId) {
  const url = `${BASE_URL}/auction?itemId=${encodeURIComponent(
    itemId
  )}&limit=1&sort=unitPrice:asc&apikey=${API_KEY}`;
  let lastErr;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const res = await axios.get(url, { timeout: 10_000 });
      const row = res?.data?.rows?.[0];
      const price = row?.unitPrice ?? row?.price ?? row?.currentPrice ?? null;
      return { ok: true, price, raw: row ?? null };
    } catch (e) {
      lastErr = e;
      await sleep(250 + i * 250);
    }
  }
  return { ok: false, error: lastErr?.message || "request_failed" };
}

async function writeAtomic(filePath, dataObj) {
  const tmp = filePath + ".tmp";
  const buf = Buffer.from(JSON.stringify(dataObj, null, 2));
  await fs.writeFile(tmp, buf);
  fssync.renameSync(tmp, filePath);
}

async function acquireLock() {
  try {
    const h = await fs.open(LOCK_FILE, "wx"); // 이미 있으면 실패
    return h;
  } catch {
    console.error("⚠️ 다른 poller 실행 중으로 보입니다. 종료합니다.");
    process.exit(0);
  }
}
async function releaseLock(h) {
  try {
    await h.close();
  } catch {}
  try {
    await fs.unlink(LOCK_FILE);
  } catch {}
}

async function pruneOldSnapshots() {
  // latest.json만 남기고 같은 폴더의 다른 .json은 제거
  try {
    const files = await fs.readdir(OUT_DIR);
    const targets = files.filter(
      (f) => f.endsWith(".json") && f !== "latest.json"
    );
    await Promise.all(targets.map((f) => fs.unlink(path.join(OUT_DIR, f))));
  } catch {}
}

async function main() {
  await ensureDir(OUT_DIR);
  const lock = await acquireLock();

  try {
    const items = await readItems();
    console.log(
      `▶ 총 ${items.length}개 품목 가격 수집 시작 (CONCURRENCY=${CONCURRENCY})`
    );

    const limit = pLimit(CONCURRENCY);
    const fetchedAt = isoKST();

    const resultMap = Object.create(null);
    let idx = 0;

    await Promise.all(
      items.map((it) =>
        limit(async () => {
          await sleep((idx++ % CONCURRENCY) * SLEEP_MS_BETWEEN);
          const { ok, price } = await fetchLowestPrice(it.itemId);
          resultMap[it.itemId] = {
            itemName: it.itemName,
            lowestPrice: ok ? price : null,
            fetchedAt,
          };
        })
      )
    );

    const snapshot = {
      meta: {
        fetchedAt,
        count: items.length,
        note: "Neople DF auction lowestPrice (latest only)",
      },
      items: resultMap, // key = itemId
    };

    await writeAtomic(OUT_FILE, snapshot);
    await pruneOldSnapshots();

    console.log(
      `✅ 최신 데이터 저장 완료: ${isoKST()} ${path.relative(
        process.cwd(),
        OUT_FILE
      )}`
    );
  } finally {
    await releaseLock(lock);
  }
}

main().catch((e) => {
  console.error("❌ Poller 실패:", e?.stack || e?.message || e);
  process.exit(1);
});
