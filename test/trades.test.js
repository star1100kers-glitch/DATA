// 실거래(분양권전매 · 전월세) 검산 — 실제 API·인증키 없이 가짜 응답으로 (Node 내장 node:test)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const M = require("../market");
const T = require("../trades");
const R = require("../region");
const Report = require("../report");
const { PRESETS, toInput } = require("../presets");

const FAKE_KEY = "TEST+KEY/abc==";
const TODAY = new Date(2026, 10, 16); // 2026-11-16

// 기술문서 응답 형식(XML)
const xml = (items, { code = "000", total = items.length, page = 1, rows = 1000 } = {}) => `<?xml version="1.0" encoding="UTF-8"?>
<response><header><resultCode>${code}</resultCode><resultMsg>OK</resultMsg></header><body><items>${
  items.slice((page - 1) * rows, page * rows).map(i => `<item>${Object.entries(i).map(([k, v]) => `<${k}>${v}</${k}>`).join("")}</item>`).join("")
}</items><numOfRows>${rows}</numOfRows><pageNo>${page}</pageNo><totalCount>${total}</totalCount></body></response>`;
const silv = (o = {}) => ({ sggCd: "26350", umdNm: "우동", aptNm: "A", excluUseAr: "84.97", dealYear: "2026", dealMonth: "1", dealDay: "3", dealAmount: "95,815", cdealType: " ", cdealDay: " ", ...o });
const rent = (o = {}) => ({ sggCd: "26350", umdNm: "우동", aptNm: "A", excluUseAr: "84.97", dealYear: "2026", dealMonth: "1", dealDay: "3", deposit: "50,000", monthlyRent: "0", contractType: "신규", ...o });

// 법정동코드 API(JSON) + 실거래 API(XML)를 흉내 내는 가짜 fetch
function fakeApi({ silvByYm = {}, rentByYm = {}, failYm = null, log = [] } = {}) {
  return async url => {
    log.push(url);
    const u = new URL(url);
    if (u.pathname.includes("StanReginCd")) {
      const rows = [{ region_cd: "2635000000", sgg_cd: "350", umd_cd: "000", ri_cd: "00", locatadd_nm: "부산광역시 해운대구" }]
        .filter(r => r.locatadd_nm.includes(u.searchParams.get("locatadd_nm")));
      return { status: 200, text: async () => JSON.stringify({ StanReginCd: [{ head: [{ RESULT: { resultCode: "INFO-0" } }] }, { row: rows }] }) };
    }
    const ym = u.searchParams.get("DEAL_YMD");
    if (ym === failYm) throw new Error("network down " + url);
    const src = u.pathname.includes("SilvTrade") ? silvByYm : rentByYm;
    const items = src[ym] || [];
    if (!items.length) return { status: 200, text: async () => xml([], { code: "03" }) };
    const page = +u.searchParams.get("pageNo"), rows = +u.searchParams.get("numOfRows");
    return { status: 200, text: async () => xml(items, { page, rows }) };
  };
}
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "trades-"));
test.beforeEach(() => { R.clearCache(); T.clearInflight(); });

test("기술문서 응답 예제(XML)를 읽는다", () => {
  const p = M.parseXml(xml([silv({ aptNm: "청계 SK VIEW", dealAmount: "95,815", cdealType: " " })], { total: 1 }));
  assert.equal(p.resultCode, "000");
  assert.equal(p.totalCount, 1);
  assert.equal(p.items[0].aptNm, "청계 SK VIEW");
  assert.equal(M.num(p.items[0].dealAmount), 95815);
});

test("최근 12개월: 이번 달 포함, 오래된 달부터, 해 넘김", () => {
  const m = M.recentMonths(TODAY);
  assert.equal(m.length, 12);
  assert.equal(m[0], "202512");
  assert.equal(m[11], "202611");
});

test("분양권: 해제여부(cdealType) 표시 거래는 뺀다", () => {
  const s = M.summarizeSilv([silv(), silv({ cdealType: "O" }), silv({ cdealType: " " })]);
  assert.deepEqual(s, { total: 3, cancelled: 1, count: 2 });
});

test("전월세: 84㎡ 신규 전세만 남기고 월세 · 갱신 · 미기재 · 84㎡ 외를 나눠 센다", () => {
  const s = M.summarizeRent([
    rent({ deposit: "60,000" }),                         // 기준 충족
    rent({ excluUseAr: "83.00", deposit: "40,000" }),     // 경계: 83 포함
    rent({ excluUseAr: "85.99", deposit: "50,000" }),     // 경계: 86 미만 포함
    rent({ excluUseAr: "82.99" }),                        // 84㎡ 아님
    rent({ excluUseAr: "86.00" }),                        // 84㎡ 아님
    rent({ monthlyRent: "120" }),                         // 월세
    rent({ contractType: "갱신" }),                       // 갱신
    rent({ contractType: " " }),                          // 계약구분 미기재
  ]);
  assert.deepEqual(s.q84, [60000, 40000, 50000]);
  assert.equal(s.count, 8);
  assert.equal(s.n84, 6);
  assert.deepEqual(s.x84, { wolse: 1, renew: 1, unknown: 1 });
  assert.equal(s.jeonse, 7);
  assert.equal(s.wolse, 1);
});

test("요청은 기술문서 파라미터대로(https) · 1,000건 넘으면 페이지를 넘긴다", async () => {
  const log = [];
  const many = Array.from({ length: 1500 }, () => rent());
  const items = await T.fetchMonthItems("rent", "26350", "202601", FAKE_KEY, fakeApi({ rentByYm: { 202601: many }, log }));
  assert.equal(items.length, 1500);
  assert.equal(log.length, 2);
  const u = new URL(log[1]);
  assert.equal(u.origin + u.pathname, "https://apis.data.go.kr/1613000/RTMSDataSvcAptRent/getRTMSDataSvcAptRent");
  assert.equal(u.searchParams.get("LAWD_CD"), "26350");
  assert.equal(u.searchParams.get("DEAL_YMD"), "202601");
  assert.equal(u.searchParams.get("pageNo"), "2");
  assert.equal(u.searchParams.get("serviceKey"), FAKE_KEY);
});

test("결과코드 03(No Data)은 0건으로 정상 처리", async () => {
  const items = await T.fetchMonthItems("silv", "26350", "202601", FAKE_KEY, fakeApi());
  assert.deepEqual(items, []);
});

test("같은 조회는 하루 동안 다시 부르지 않고, 하루가 지나면 다시 부른다", async () => {
  const dir = tmpDir();
  let t = Date.parse("2026-11-16T09:00:00Z");
  const log = [];
  const opts = { key: FAKE_KEY, fetchImpl: fakeApi({ silvByYm: { 202601: [silv()] }, log }), now: () => t, cacheDir: dir };
  try {
    const a = await T.getMonth("silv", "26350", "202601", opts);
    t += 23 * 3600e3;
    const b = await T.getMonth("silv", "26350", "202601", opts);
    assert.equal(a.cached, false);
    assert.equal(b.cached, true);
    assert.equal(log.length, 1);
    t += 2 * 3600e3; // 25시간 경과
    const c = await T.getMonth("silv", "26350", "202601", opts);
    assert.equal(c.cached, false);
    assert.equal(log.length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("실패한 달은 캐시하지 않아 [다시 시도]가 실제로 다시 부른다 · 오류에 키 없음", async () => {
  const dir = tmpDir();
  const log = [];
  try {
    const bad = await T.getMonth("rent", "26350", "202601", { key: FAKE_KEY, fetchImpl: fakeApi({ failYm: "202601", log }), cacheDir: dir });
    assert.equal(bad.status, "error");
    assert.ok(!JSON.stringify(bad).includes("TEST") && !JSON.stringify(bad).includes("abc"));
    const ok = await T.getMonth("rent", "26350", "202601", { key: FAKE_KEY, fetchImpl: fakeApi({ rentByYm: { 202601: [rent()] }, log }), cacheDir: dir });
    assert.equal(ok.status, "ok");
    assert.equal(log.length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("인증키 오류 응답(공공데이터포털 공통 형식)", async () => {
  const auth = async () => ({ status: 200, text: async () => "<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE ERROR</errMsg><returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg><returnReasonCode>30</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>" });
  await assert.rejects(T.fetchMonthItems("silv", "26350", "202601", FAKE_KEY, auth), /인증키 오류/);
});

test("스트림: 이름만 받아 서버가 코드를 확인 → 종류별 12개월 → 실패 달은 오류로", async () => {
  const dir = tmpDir();
  const events = [];
  try {
    await T.streamTrades("부산광역시 해운대구", e => events.push(e), {
      key: FAKE_KEY, today: TODAY, cacheDir: dir,
      fetchImpl: fakeApi({ silvByYm: { 202601: [silv(), silv({ cdealType: "O" })] }, rentByYm: { 202601: [rent()] }, failYm: "202603" }),
    });
    assert.equal(events[0].type, "region");
    assert.equal(events[0].code, "26350");
    assert.equal(events[1].type, "start");
    const months = events.filter(e => e.type === "month");
    assert.equal(months.filter(e => e.kind === "silv").length, 12);
    assert.equal(months.filter(e => e.kind === "rent").length, 12);
    assert.equal(months.find(e => e.kind === "silv" && e.ym === "202601").summary.count, 1);
    assert.equal(months.filter(e => e.status === "error").length, 2); // 202603 분양권 · 전월세
    assert.equal(events.at(-1).type, "done");
    assert.ok(!JSON.stringify(events).includes("TEST+KEY"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("지역이 정확히 하나로 맞지 않으면 실거래 API를 부르지 않는다", async () => {
  const log = [], events = [];
  await T.streamTrades("부산 해운대구", e => events.push(e), { key: FAKE_KEY, today: TODAY, fetchImpl: fakeApi({ log }) });
  assert.equal(events[0].status, "ambiguous");
  assert.ok(log.every(u => u.includes("StanReginCd")));
});

test("[다시 시도]는 최근 12개월 밖의 달을 받지 않는다", async () => {
  const r = await T.retryMonth("부산광역시 해운대구", "silv", "202001", { key: FAKE_KEY, today: TODAY, fetchImpl: fakeApi() });
  assert.equal(r.status, "error");
});

test("2장 표: 월별 건수 합계 · 잔금 여력 = 84㎡ 신규 전세 평균 ÷ 우리 84㎡ 세대당 분양가 (샘플 A)", () => {
  const months = M.recentMonths(TODAY);
  const state = { name: "부산광역시 해운대구", code: "26350", months, silv: {}, rent: {}, done: true };
  for (const ym of months) {
    state.silv[ym] = { status: "ok", summary: M.summarizeSilv([silv(), silv({ cdealType: "O" })]), fetchedAt: "2026-11-16T00:00:00Z" };
    state.rent[ym] = { status: "ok", summary: M.summarizeRent([rent({ deposit: "60,000" }), rent({ deposit: "50,000" }), rent({ contractType: "갱신" })]), fetchedAt: "2026-11-16T00:00:00Z" };
  }
  state.rent[months[0]] = { status: "error", message: "x" };
  const A = { name: PRESETS.A.name, site: PRESETS.A.site, ...toInput(PRESETS.A) };
  const mk = Report.buildReport(A, 1, { status: "ok", name: "부산광역시 해운대구", code: "26350" }, state).market;
  assert.equal(mk.ok, true);
  assert.equal(mk.table1.totals.silv, 12);
  assert.equal(mk.table1.totals.silvCancelled, 12);
  assert.equal(mk.table1.totals.rent, 33);
  assert.equal(mk.table1.errors.length, 1);
  assert.equal(mk.table2.n, 22);
  assert.equal(mk.table2.avg, 55000);
  assert.equal(mk.table2.excluded.renew, 11);
  assert.equal(mk.table2.ours.length, 1);              // 84형 84.9㎡ 만 해당 (59형 제외)
  assert.equal(Math.round(mk.table2.ours[0].unitPrice), 83732); // 34.6평 × 2,420만원
  assert.equal((mk.table2.ours[0].ratio * 100).toFixed(1), "65.7");
  assert.deepEqual(mk.dates, ["2026-11-16"]);
});
