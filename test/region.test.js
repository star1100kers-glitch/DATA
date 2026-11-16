// 지역 확인(법정동코드) 검산 — 실제 API·인증키 없이 가짜 응답으로 확인 (Node 내장 node:test)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const R = require("../region");
const Report = require("../report");

// 기술문서 응답 항목대로 만든 행
const row = (cd, nm) => ({
  region_cd: cd, sido_cd: cd.slice(0, 2), sgg_cd: cd.slice(2, 5), umd_cd: cd.slice(5, 8), ri_cd: cd.slice(8, 10),
  locatadd_nm: nm, locallow_nm: nm.split(" ").pop(),
});
// 실제 JSON 응답 모양: { StanReginCd: [ {head:[...]}, {row:[...]} ] }
const body = rows => JSON.stringify({ StanReginCd: [
  { head: [{ totalCount: rows.length }, { numOfRows: "1000", pageNo: "1", type: "JSON" }, { RESULT: { resultCode: rows.length ? "INFO-0" : "INFO-200", resultMsg: "NOMAL SERVICE" } }] },
  ...(rows.length ? [{ row: rows }] : []),
] });

const DB = [
  row("2600000000", "부산광역시"),
  row("2635000000", "부산광역시 해운대구"),
  row("2635010500", "부산광역시 해운대구 우동"),
  row("2635010600", "부산광역시 해운대구 중동"),
  row("4111000000", "경기도 수원시"),
  row("4111700000", "경기도 수원시 영통구"),
  row("4111710100", "경기도 수원시 영통구 매탄동"),
  row("4111300000", "경기도 수원시 권선구"),
  row("3000000000", "대전광역시"),
  row("3020000000", "대전광역시 유성구"),
  row("2720000000", "대구광역시 중구"),
  row("2611000000", "부산광역시 중구"),
  row("1114000000", "서울특별시 중구"),
];
const FAKE_KEY = "TEST+KEY/abc==";

// 가짜 fetch: locatadd_nm 을 포함하는 행을 돌려주고, 받은 URL을 기록
function fakeFetch(log = []) {
  return async url => {
    log.push(url);
    const q = new URL(url).searchParams.get("locatadd_nm");
    const rows = DB.filter(r => r.locatadd_nm.includes(q));
    return { status: 200, text: async () => body(rows) };
  };
}
test.beforeEach(() => R.clearCache()); // 테스트끼리 캐시가 섞이지 않게
const look = (name, opts = {}) => R.lookupRegion(name, { key: FAKE_KEY, fetchImpl: fakeFetch(opts.log), ...opts });

test("샘플 A·B·C 사업대상지 → 시군구 5자리", async () => {
  assert.deepEqual(await look("부산광역시 해운대구").then(r => [r.status, r.code]), ["ok", "26350"]);
  assert.deepEqual(await look("경기도 수원시 영통구").then(r => [r.status, r.code]), ["ok", "41117"]);
  assert.deepEqual(await look("대전광역시 유성구").then(r => [r.status, r.code]), ["ok", "30200"]);
});

test("공백이 섞여도 같은 이름으로 본다", async () => {
  const r = await look("  부산광역시   해운대구 ");
  assert.equal(r.status, "ok");
  assert.equal(r.code, "26350");
});

test("정확히 하나가 아니면 통과하지 않고 시군구 후보만 보여준다", async () => {
  const r = await look("경기도 수원");
  assert.equal(r.status, "ambiguous");
  assert.equal(r.code, undefined);
  assert.deepEqual(r.candidates.map(c => c.code).sort(), ["41110", "41113", "41117"]);
  assert.ok(r.candidates.every(c => c.code.length === 5));
});

test("후보가 하나뿐이어도 이름이 정확히 같지 않으면 통과하지 않는다", async () => {
  const r = await look("경기도 수원시 영");
  assert.equal(r.status, "ambiguous");
  assert.deepEqual(r.candidates.map(c => c.code), ["41117"]);
});

test("시도까지만 쓰면 통과하지 않고 그 아래 시군구 후보", async () => {
  const r = await look("부산광역시");
  assert.equal(r.status, "ambiguous");
  assert.deepEqual(r.candidates.map(c => c.name).sort(), ["부산광역시 중구", "부산광역시 해운대구"]);
});

test("시도를 빼고 쓰면 마지막 단어로 다시 찾아 후보 제시 (동명 '중구' 3곳)", async () => {
  const r = await look("서울 중구");
  assert.equal(r.status, "ambiguous");
  assert.equal(r.candidates.length, 3);
});

test("읍면동 이름은 시군구가 아니므로 통과하지 않는다", async () => {
  const r = await look("부산광역시 해운대구 우동");
  assert.notEqual(r.status, "ok");
});

test("없는 지역은 notfound", async () => {
  const r = await look("제주특별자치도 없는시");
  assert.equal(r.status, "notfound");
  assert.deepEqual(r.candidates, []);
});

test("실제 API의 결과 0건 응답(INFO-3 데이터없음)은 오류가 아니라 notfound", async () => {
  const empty = JSON.stringify({ StanReginCd: [{ head: [{ totalCount: 0 }, { RESULT: { resultCode: "INFO-3", resultMsg: "데이터없음 에러" } }] }] });
  const r = await R.lookupRegion("없는곳", { key: FAKE_KEY, fetchImpl: async () => ({ status: 200, text: async () => empty }) });
  assert.equal(r.status, "notfound");
});

test("키가 없으면 API를 부르지 않고 nokey", async () => {
  const log = [];
  const r = await R.lookupRegion("부산광역시 해운대구", { key: null, fetchImpl: fakeFetch(log) });
  assert.equal(r.status, "nokey");
  assert.equal(log.length, 0);
});

test("요청은 기술문서 파라미터대로, https로", async () => {
  const log = [];
  await look("대전광역시 유성구", { log });
  const u = new URL(log[0]);
  assert.equal(u.origin + u.pathname, "https://apis.data.go.kr/1741000/StanReginCd/getStanReginCdList");
  assert.equal(u.searchParams.get("type"), "json");
  assert.equal(u.searchParams.get("flag"), "Y");
  assert.equal(u.searchParams.get("pageNo"), "1");
  assert.equal(u.searchParams.get("numOfRows"), "1000");
  assert.equal(u.searchParams.get("locatadd_nm"), "대전광역시 유성구");
  assert.equal(u.searchParams.get("ServiceKey"), FAKE_KEY); // 인코딩 후 원래 키로 복원됨
});

test("인코딩 키(%2B 등)를 넣어도 이중 인코딩하지 않는다", () => {
  assert.equal(R.encodeKey("TEST%2BKEY%2Fabc%3D%3D"), R.encodeKey("TEST+KEY/abc=="));
});

test("결과·오류 어디에도 인증키가 들어가지 않는다", async () => {
  const ok = await look("부산광역시 해운대구");
  R.clearCache();
  const fail = await R.lookupRegion("부산광역시 해운대구", { key: FAKE_KEY, fetchImpl: async () => { throw new Error("boom " + FAKE_KEY); } });
  const auth = await R.lookupRegion("x", { key: FAKE_KEY, fetchImpl: async () => ({ status: 401, text: async () => JSON.stringify({ OpenAPI_ServiceResponse: { cmmMsgHeader: { errMsg: "SERVICE_KEY_IS_NOT_REGISTERED_ERROR", returnAuthMsg: "SERVICE_KEY_IS_NOT_REGISTERED_ERROR" } } }) }) });
  assert.equal(fail.status, "error");
  assert.equal(auth.status, "error");
  assert.match(auth.message, /인증키 오류/);
  for (const r of [ok, fail, auth]) {
    const s = JSON.stringify(r);
    assert.ok(!s.includes("TEST") && !s.includes("abc"), s);
  }
});

test(".env.local 읽기: 값이 비면 키 없음, 있으면 읽음 (임시 파일)", () => {
  const saved = process.env.DATA_GO_KR_KEY;
  delete process.env.DATA_GO_KR_KEY;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "envtest-"));
  const f = path.join(dir, ".env.local");
  try {
    fs.writeFileSync(f, "DATA_GO_KR_KEY=\n");
    assert.equal(R.loadKey(f), null);
    fs.writeFileSync(f, "# 주석\nDATA_GO_KR_KEY=abc123\n");
    assert.equal(R.loadKey(f), "abc123");
    assert.equal(R.loadKey(path.join(dir, "없는파일")), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (saved !== undefined) process.env.DATA_GO_KR_KEY = saved;
  }
});

test("1장·7장: 확인된 지역만 코드로 표시, 아니면 7장에 미확인", () => {
  const raw = { name: "x", site: "부산광역시 해운대구", units: [], price: null, retail: null, other: null, fixed: null, pf: null, pfCost: null, sub: null };
  const ok = Report.buildReport(raw, 1, { status: "ok", name: "부산광역시 해운대구", code: "26350" });
  assert.equal(ok.overview.regionCode, "26350");
  assert.ok(!ok.unverified.some(t => t.includes("법정동코드")));
  const amb = Report.buildReport(raw, 1, { status: "ambiguous", candidates: [{ name: "a", code: "11111" }] });
  assert.equal(amb.overview.regionCode, null);
  assert.ok(amb.unverified.some(t => t.includes("법정동코드 미확인")));
});
