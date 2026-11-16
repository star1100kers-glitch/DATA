// 사업대상지 → 시군구 법정동코드(5자리) 확인 · 서버 전용 모듈 (브라우저로 보내지 않음)
// 근거: 행정안전부_행정표준코드_법정동코드 Open API 활용가이드 (StanReginCd / getStanReginCdList)
// 인증키는 .env.local 의 DATA_GO_KR_KEY 에서 읽고, 응답·로그·오류 메시지 어디에도 넣지 않습니다.
"use strict";
const fs = require("fs");
const path = require("path");

const API_URL = "https://apis.data.go.kr/1741000/StanReginCd/getStanReginCdList"; // 기술문서는 http, 키 보호를 위해 https 사용
const ENV_FILE = path.join(__dirname, ".env.local");
const MAX_ROWS = 1000; // 기술문서: 한 번에 최대 1,000건

// 인증키를 읽습니다. 환경변수가 있으면 우선, 없으면 .env.local. 없으면 null.
// 키 값은 이 함수 밖으로 로그·응답에 나가지 않습니다.
function loadKey(envFile = ENV_FILE) {
  if (process.env.DATA_GO_KR_KEY && process.env.DATA_GO_KR_KEY.trim()) return process.env.DATA_GO_KR_KEY.trim();
  let text;
  try { text = fs.readFileSync(envFile, "utf8"); } catch { return null; }
  const line = text.split(/\r?\n/).find(l => /^\s*DATA_GO_KR_KEY\s*=/.test(l));
  if (!line) return null;
  const v = line.replace(/^\s*DATA_GO_KR_KEY\s*=\s*/, "").trim().replace(/^["']|["']$/g, "");
  return v || null;
}

// 공공데이터포털은 "인코딩 키(%2B 등 포함)"와 "디코딩 키"를 함께 줍니다. 어느 쪽을 넣어도 되도록
// 한 번 풀었다가 다시 URL 인코딩합니다.
function encodeKey(key) {
  let k = key;
  if (/%[0-9A-Fa-f]{2}/.test(k)) { try { k = decodeURIComponent(k); } catch { /* 그대로 사용 */ } }
  return encodeURIComponent(k);
}

// 이름 비교용 정리: 앞뒤 공백 제거, 연속 공백은 하나로
const normalize = s => String(s || "").trim().replace(/\s+/g, " ");

// API 행이 시군구 행인지: 시군구코드가 있고 읍면동·리 코드가 0
const isSigungu = r => r.sgg_cd && r.sgg_cd !== "000" && r.umd_cd === "000" && (r.ri_cd === "00" || !r.ri_cd);

// 시군구 행을 { name, code(5자리), regionCd(10자리) } 로 바꿉니다.
const toCandidate = r => ({ name: normalize(r.locatadd_nm), code: String(r.region_cd).slice(0, 5), regionCd: String(r.region_cd) });

// 응답 행 목록에서 입력 이름과 정확히 하나로 맞는 시군구를 찾습니다.
//  - 시군구 행 중 지역주소명이 입력과 완전히 같은 것이 딱 1개 → { status: "ok" }
//  - 그 외 → 시군구 후보 목록과 함께 { status: "ambiguous" | "notfound" }
function matchRegion(rows, name) {
  const target = normalize(name);
  const seen = new Map();
  for (const r of rows.filter(isSigungu).map(toCandidate)) if (!seen.has(r.regionCd)) seen.set(r.regionCd, r);
  const sigungu = [...seen.values()];
  const exact = sigungu.filter(c => c.name === target);
  if (exact.length === 1) return { status: "ok", query: target, name: exact[0].name, code: exact[0].code, regionCd: exact[0].regionCd };
  const candidates = (exact.length > 1 ? exact : sigungu).slice(0, 30);
  return { status: candidates.length ? "ambiguous" : "notfound", query: target, candidates };
}

// 응답 JSON에서 row 배열과 결과코드를 찾습니다. (응답 구조가 중첩 배열이라 재귀로 탐색)
function parseResponse(json) {
  const rows = [];
  let resultCode = null, resultMsg = null, authError = null;
  (function walk(v) {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v.row)) rows.push(...v.row);
    if (v.RESULT && v.RESULT.resultCode) { resultCode = v.RESULT.resultCode; resultMsg = v.RESULT.resultMsg; }
    if (v.cmmMsgHeader) authError = v.cmmMsgHeader.returnAuthMsg || v.cmmMsgHeader.errMsg || "인증 오류";
    Object.values(v).forEach(walk);
  })(json);
  return { rows, resultCode, resultMsg, authError };
}

// API를 한 번 호출해 행 목록을 가져옵니다. 오류 메시지에 URL(=키)을 넣지 않습니다.
async function fetchRows(name, key, fetchImpl = fetch) {
  const url = `${API_URL}?ServiceKey=${encodeKey(key)}&type=json&pageNo=1&numOfRows=${MAX_ROWS}&flag=Y&locatadd_nm=${encodeURIComponent(name)}`;
  let res, text;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(10000) });
    text = await res.text();
  } catch (e) {
    throw new Error("공공데이터 API에 연결하지 못했습니다");
  }
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`공공데이터 API 응답을 읽지 못했습니다 (HTTP ${res.status})`); }
  const p = parseResponse(json);
  if (p.authError) throw new Error(`인증키 오류: ${p.authError}`);
  // 정상: INFO-0(정상 처리) · INFO-200(해당 데이터 없음, 기술문서)
  //       INFO-3(데이터없음 — 기술문서에는 없지만 실제 API가 결과 0건일 때 돌려줌)
  // 나머지는 오류(INFO-300 인증키 제한 포함)
  if (p.resultCode && !/^INFO-(0|200|3)$/.test(p.resultCode)) throw new Error(`공공데이터 API 오류 ${p.resultCode}: ${p.resultMsg || ""}`.trim());
  return p.rows;
}

const cache = new Map();

// 사업대상지 이름 → 법정동코드 확인 (서버 라우트에서 호출)
// 이름 그대로 조회해 후보가 없으면, 마지막 단어(예: "해운대구")로 한 번 더 찾아 후보만 보여줍니다.
async function lookupRegion(name, { key = loadKey(), fetchImpl = fetch } = {}) {
  const q = normalize(name);
  if (!q) return { status: "empty" };
  if (!key) return { status: "nokey", query: q };
  if (cache.has(q)) return cache.get(q);
  try {
    let result = matchRegion(await fetchRows(q, key, fetchImpl), q);
    const last = q.split(" ").pop();
    if (result.status === "notfound" && last !== q) {
      const more = matchRegion(await fetchRows(last, key, fetchImpl), q);
      if (more.candidates && more.candidates.length) result = { status: "ambiguous", query: q, candidates: more.candidates };
    }
    cache.set(q, result);
    return result;
  } catch (e) {
    return { status: "error", query: q, message: e.message };
  }
}

// 조회 결과 캐시 비우기 (테스트 · 키 변경 후 재조회용)
function clearCache() { cache.clear(); }

module.exports = { API_URL, loadKey, encodeKey, normalize, isSigungu, matchRegion, parseResponse, fetchRows, lookupRegion, clearCache };
