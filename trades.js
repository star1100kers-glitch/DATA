// 실거래가 조회 · 서버 전용 (인증키는 여기서만 사용, 브라우저로 보내지 않음)
//  - 분양권전매: RTMSDataSvcSilvTrade / 전월세: RTMSDataSvcAptRent (기술문서: LAWD_CD 5자리 + DEAL_YMD 6자리, XML 응답)
//  - 한 달씩 나눠 부르고, 같은 조회(종류·지역·월)는 하루 동안 다시 부르지 않음(.cache 폴더)
"use strict";
const fs = require("fs");
const path = require("path");
const Market = require("./market");
const { loadKey, encodeKey, lookupRegion } = require("./region");

const KINDS = {
  silv: { url: "https://apis.data.go.kr/1613000/RTMSDataSvcSilvTrade/getRTMSDataSvcSilvTrade", summarize: Market.summarizeSilv },
  rent: { url: "https://apis.data.go.kr/1613000/RTMSDataSvcAptRent/getRTMSDataSvcAptRent", summarize: Market.summarizeRent },
};
const TTL = 24 * 60 * 60 * 1000;   // 하루
const PAGE_SIZE = 1000;
const MAX_PAGES = 20;
const SUMMARY_VERSION = 1;          // 집계 기준이 바뀌면 올려서 옛 캐시를 무시
const DEFAULT_CACHE_DIR = path.join(__dirname, ".cache", "trades");

// 한 달치 거래를 페이지를 넘기며 모두 가져옵니다. 오류 메시지에 URL(=키)을 넣지 않습니다.
async function fetchMonthItems(kind, code, ym, key, fetchImpl = fetch) {
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${KINDS[kind].url}?serviceKey=${encodeKey(key)}&LAWD_CD=${code}&DEAL_YMD=${ym}&pageNo=${page}&numOfRows=${PAGE_SIZE}`;
    let res, text;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(20000) });
      text = await res.text();
    } catch {
      throw new Error("공공데이터 API에 연결하지 못했습니다");
    }
    const p = Market.parseXml(text);
    if (p.authError) throw new Error(`인증키 오류: ${p.authError}`);
    if (p.resultCode === "03") break; // 기술문서: 03 No Data
    if (!p.resultCode) throw new Error(`공공데이터 API 응답을 읽지 못했습니다 (HTTP ${res.status})`);
    if (!/^0+$/.test(p.resultCode)) throw new Error(`공공데이터 API 오류 ${p.resultCode}: ${p.resultMsg || ""}`.trim());
    items.push(...p.items);
    const total = p.totalCount === null ? items.length : p.totalCount;
    if (!p.items.length || items.length >= total) break;
  }
  return items;
}

const inflight = new Map();

// 한 달 결과(요약)를 돌려줍니다. 하루 안에 같은 조회를 했으면 캐시를 씁니다.
// 반환: { status: "ok", summary, fetchedAt, cached } | { status: "error", message }
async function getMonth(kind, code, ym, { key = loadKey(), fetchImpl = fetch, now = () => Date.now(), cacheDir = DEFAULT_CACHE_DIR } = {}) {
  if (!KINDS[kind]) return { status: "error", message: "알 수 없는 종류" };
  if (!/^\d{5}$/.test(code) || !/^\d{6}$/.test(ym)) return { status: "error", message: "지역코드·계약월 형식 오류" };
  if (!key) return { status: "error", message: "공공데이터 인증키(.env.local) 미설정" };

  const file = path.join(cacheDir, `${kind}-${code}-${ym}.json`);
  try {
    const c = JSON.parse(fs.readFileSync(file, "utf8"));
    if (c.v === SUMMARY_VERSION && now() - Date.parse(c.fetchedAt) < TTL) return { status: "ok", summary: c.summary, fetchedAt: c.fetchedAt, cached: true };
  } catch { /* 캐시 없음 */ }

  const id = file;
  if (inflight.has(id)) return inflight.get(id);
  const job = (async () => {
    try {
      const items = await fetchMonthItems(kind, code, ym, key, fetchImpl);
      const summary = KINDS[kind].summarize(items);
      const fetchedAt = new Date(now()).toISOString();
      try {
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ v: SUMMARY_VERSION, fetchedAt, summary }));
      } catch { /* 캐시 저장 실패는 무시 */ }
      return { status: "ok", summary, fetchedAt, cached: false };
    } catch (e) {
      return { status: "error", message: e.message }; // 실패한 달은 캐시하지 않음
    } finally {
      inflight.delete(id);
    }
  })();
  inflight.set(id, job);
  return job;
}

// 지역 이름 → 서버에서 코드를 다시 확인 → 최근 12개월을 종류별로 한 달씩 조회하며 결과를 하나씩 내보냅니다.
// send(obj) 로 줄 단위 이벤트를 보내고, isClosed() 가 참이면 멈춥니다.
async function streamTrades(name, send, opts = {}) {
  const { isClosed = () => false, today = new Date() } = opts;
  const region = await lookupRegion(name, opts);
  send({ type: "region", status: region.status, name: region.name || null, code: region.code || null, query: region.query || name, message: region.message || null });
  if (region.status !== "ok") return send({ type: "done" });

  const months = Market.recentMonths(today);
  send({ type: "start", name: region.name, code: region.code, months });
  await Promise.all(Object.keys(KINDS).map(async kind => {
    for (const ym of months) {
      if (isClosed()) return;
      const r = await getMonth(kind, region.code, ym, opts);
      if (isClosed()) return;
      send({ type: "month", kind, ym, ...r });
    }
  }));
  send({ type: "done" });
}

// 한 달만 다시 조회 ([다시 시도]) — 지역은 서버에서 다시 확인
async function retryMonth(name, kind, ym, opts = {}) {
  const region = await lookupRegion(name, opts);
  if (region.status !== "ok") return { status: "error", message: "지역 확인 실패" };
  if (!Market.recentMonths(opts.today || new Date()).includes(ym)) return { status: "error", message: "최근 12개월이 아닌 계약월" };
  return { kind, ym, ...(await getMonth(kind, region.code, ym, opts)) };
}

function clearInflight() { inflight.clear(); }

module.exports = { KINDS, TTL, fetchMonthItems, getMonth, streamTrades, retryMonth, clearInflight };
