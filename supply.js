// 인근 신규 공급 평당가 · 서버 전용 (인증키는 여기서만 사용, 브라우저로 보내지 않음)
// 근거: 청약홈 분양정보 조회 서비스 기술문서 (한국부동산원, ApplyhomeInfoDetailSvc)
//  1) getAPTLttotPblancDetail : APT 분양정보 상세조회 — 공급위치(LIKE) · 모집공고일 범위로 공고 목록
//  4) getAPTLttotPblancMdl    : APT 분양정보 주택형별 상세조회 — 주택형 · 공급면적 · 분양최고금액
// 같은 조회(지역 · 기간)는 하루 동안 다시 부르지 않음(.cache 폴더)
"use strict";
const fs = require("fs");
const path = require("path");
const Market = require("./market");
const { loadKey, encodeKey, lookupRegion } = require("./region");

const BASE = "https://api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1";
const SOURCE = "청약홈 분양정보 (한국부동산원) · APT 분양정보 상세 · 주택형별 상세";
const TTL = 24 * 60 * 60 * 1000;
const PER_PAGE = 100;
const MAX_PAGES = 10;
const CACHE_VERSION = 1;
const DEFAULT_CACHE_DIR = path.join(__dirname, ".cache", "supply");

const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// 조회 기간: 오늘 기준 최근 24개월 (모집공고일)
function supplyWindow(today = new Date()) {
  const from = new Date(today.getFullYear(), today.getMonth() - Market.SUPPLY_MONTHS, today.getDate());
  return { from: ymd(from), to: ymd(today) };
}

// odcloud API 한 번 호출 (JSON). cond[필드::연산자]=값 형식. 오류 메시지에 URL(=키)을 넣지 않습니다.
async function callApi(fn, cond, page, key, fetchImpl) {
  const qs = [`page=${page}`, `perPage=${PER_PAGE}`, "returnType=JSON"]
    .concat(Object.entries(cond).map(([k, v]) => `${encodeURIComponent(`cond[${k}]`)}=${encodeURIComponent(v)}`))
    .concat(`serviceKey=${encodeKey(key)}`).join("&");
  let res, text;
  try {
    res = await fetchImpl(`${BASE}/${fn}?${qs}`, { signal: AbortSignal.timeout(20000) });
    text = await res.text();
  } catch {
    throw new Error("청약홈 API에 연결하지 못했습니다");
  }
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`청약홈 API 응답을 읽지 못했습니다 (HTTP ${res.status})`); }
  if (res.status === 401 || res.status === 403 || (typeof json.code === "number" && json.code < 0)) {
    throw new Error(`청약홈 API 인증 오류 — 이 서비스 활용신청 · 승인 확인 필요 (${json.msg || `HTTP ${res.status}`})`);
  }
  if (!Array.isArray(json.data)) throw new Error(`청약홈 API 오류 (HTTP ${res.status})`);
  return json;
}

// 여러 페이지를 모두 가져옵니다.
async function callAll(fn, cond, key, fetchImpl) {
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const j = await callApi(fn, cond, page, key, fetchImpl);
    rows.push(...j.data);
    const total = typeof j.matchCount === "number" ? j.matchCount : rows.length;
    if (!j.data.length || rows.length >= total) break;
  }
  return rows;
}

// 지역(확인된 시군구 전체 이름)의 최근 24개월 APT 공고 → 단지별 84㎡ 평당가 점
async function fetchSupply(regionName, key, { fetchImpl = fetch, today = new Date() } = {}) {
  const w = supplyWindow(today);
  const notices = await callAll("getAPTLttotPblancDetail", {
    "HSSPLY_ADRES::LIKE": regionName,
    "HOUSE_SECD::EQ": "01",              // APT
    "RCRIT_PBLANC_DE::GTE": w.from,
    "RCRIT_PBLANC_DE::LTE": w.to,
  }, key, fetchImpl);
  // 같은 공고가 두 번 오면 하나만
  const uniq = [...new Map(notices.map(n => [`${n.HOUSE_MANAGE_NO}-${n.PBLANC_NO}`, n])).values()];
  const points = [], excluded = { rent: 0, no84: 0, error: 0 };
  for (const n of uniq) {
    let models;
    try {
      models = await callAll("getAPTLttotPblancMdl", { "HOUSE_MANAGE_NO::EQ": n.HOUSE_MANAGE_NO, "PBLANC_NO::EQ": n.PBLANC_NO }, key, fetchImpl);
    } catch (e) {
      if (/인증 오류/.test(e.message)) throw e;
      excluded.error++; continue;
    }
    const r = Market.supplyPoint(n, models);
    if (r.point) points.push(r.point); else excluded[r.excluded]++;
  }
  points.sort((a, b) => a.date.localeCompare(b.date));
  return { window: w, notices: uniq.length, points, excluded };
}

const inflight = new Map();

// 화면용: 지역 이름 → 서버에서 다시 확인 → 공급가 점 (하루 캐시)
// 반환: { status: "ok", name, code, points, excluded, notices, window, fetchedAt, cached, source } | { status: "error"|..., message }
async function getSupply(name, { key = loadKey(), fetchImpl = fetch, now = () => Date.now(), today = new Date(), cacheDir = DEFAULT_CACHE_DIR } = {}) {
  const region = await lookupRegion(name, { key, fetchImpl });
  if (region.status !== "ok") return { status: region.status, message: region.message || "지역 확인 실패" };
  if (!key) return { status: "nokey" };
  const w = supplyWindow(today);
  const file = path.join(cacheDir, `${region.code}-${w.to.slice(0, 7)}.json`);
  try {
    const c = JSON.parse(fs.readFileSync(file, "utf8"));
    if (c.v === CACHE_VERSION && c.regionName === region.name && now() - Date.parse(c.fetchedAt) < TTL) return { ...c.result, cached: true };
  } catch { /* 캐시 없음 */ }
  if (inflight.has(file)) return inflight.get(file);
  const job = (async () => {
    try {
      const r = await fetchSupply(region.name, key, { fetchImpl, today });
      const result = { status: "ok", name: region.name, code: region.code, ...r, fetchedAt: new Date(now()).toISOString(), source: SOURCE, cached: false };
      try {
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ v: CACHE_VERSION, regionName: region.name, fetchedAt: result.fetchedAt, result }));
      } catch { /* 캐시 저장 실패는 무시 */ }
      return result;
    } catch (e) {
      return { status: "error", message: e.message }; // 실패는 캐시하지 않음
    } finally {
      inflight.delete(file);
    }
  })();
  inflight.set(file, job);
  return job;
}

module.exports = { BASE, SOURCE, supplyWindow, callApi, fetchSupply, getSupply };
