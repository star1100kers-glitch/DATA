// 인근 신규 공급 평당가(청약홈 분양정보) 검산 — 가짜 응답으로 (Node 내장 node:test)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const M = require("../market");
const S = require("../supply");
const R = require("../region");
const Report = require("../report");
const Charts = require("../charts");
const { PRESETS, toInput } = require("../presets");

const FAKE_KEY = "TEST+KEY/abc==";
const TODAY = new Date(2026, 10, 16);
const notice = (o = {}) => ({ HOUSE_MANAGE_NO: "2025000001", PBLANC_NO: "2025000001", HOUSE_NM: "가단지", HOUSE_SECD: "01", RENT_SECD: "0", RCRIT_PBLANC_DE: "2025-09-19", HSSPLY_ADRES: "부산광역시 해운대구 우동 1번지", ...o });
const model = (ty, ar, amt) => ({ HOUSE_TY: ty, SUPLY_AR: String(ar), LTTOT_TOP_AMOUNT: String(amt) });

// 법정동코드(JSON) + 청약홈(odcloud JSON)을 흉내 내는 가짜 fetch
function fakeApi({ notices = [], models = {}, authFail = false, log = [] } = {}) {
  return async url => {
    log.push(url);
    const u = new URL(url);
    if (u.pathname.includes("StanReginCd")) {
      const rows = [{ region_cd: "2635000000", sgg_cd: "350", umd_cd: "000", ri_cd: "00", locatadd_nm: "부산광역시 해운대구" }]
        .filter(r => r.locatadd_nm.includes(u.searchParams.get("locatadd_nm")));
      return { status: 200, text: async () => JSON.stringify({ StanReginCd: [{ head: [{ RESULT: { resultCode: "INFO-0" } }] }, { row: rows }] }) };
    }
    if (authFail) return { status: 401, text: async () => JSON.stringify({ code: -4, msg: "등록되지 않은 인증키 입니다." }) };
    const page = +u.searchParams.get("page"), per = +u.searchParams.get("perPage");
    let rows;
    if (u.pathname.endsWith("getAPTLttotPblancDetail")) {
      const like = u.searchParams.get("cond[HSSPLY_ADRES::LIKE]");
      rows = notices.filter(n => n.HSSPLY_ADRES.includes(like));
    } else {
      rows = models[u.searchParams.get("cond[HOUSE_MANAGE_NO::EQ]")] || [];
    }
    const data = rows.slice((page - 1) * per, page * per);
    return { status: 200, text: async () => JSON.stringify({ currentCount: data.length, data, matchCount: rows.length, page, perPage: per, totalCount: 99999 }) };
  };
}
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "supply-"));
test.beforeEach(() => R.clearCache());

test("점 1개 = 84㎡ 주택형(전용 기준)들의 분양최고금액 ÷ 공급평 평균", () => {
  const r = M.supplyPoint(notice(), [
    model("084.9800A", 112.4, 95000),   // 84㎡
    model("084.6500B", 111.9, 93000),   // 84㎡
    model("059.9900A", 80.1, 70000),    // 59㎡ — 제외
  ]);
  const expect = ((95000 / (112.4 / M.M2_PER_PYEONG)) + (93000 / (111.9 / M.M2_PER_PYEONG))) / 2;
  assert.equal(r.point.price, expect);
  assert.equal(r.point.types, 2);
  assert.equal(r.point.ym, "2025-09");
  assert.equal(Math.round(95000 / (112.4 / 3.305785)), Math.round(95000 / (112.4 / M.M2_PER_PYEONG)));
});

test("임대 공고 · 84㎡ 없는 단지는 점에서 빼고 이유를 남긴다", () => {
  assert.deepEqual(M.supplyPoint(notice({ RENT_SECD: "1" }), [model("084.9800A", 112, 90000)]), { excluded: "rent" });
  assert.deepEqual(M.supplyPoint(notice(), [model("059.9900A", 80, 70000)]), { excluded: "no84" });
  assert.deepEqual(M.supplyPoint(notice(), [model("084.9800A", 112, "")]), { excluded: "no84" }); // 금액 없음
});

test("요청: 기술문서대로 odcloud(https) · 공급위치 LIKE = 서버가 확인한 지역 이름 · 최근 24개월 · APT", async () => {
  const log = [];
  await S.fetchSupply("부산광역시 해운대구", FAKE_KEY, { today: TODAY, fetchImpl: fakeApi({ log }) });
  const u = new URL(log[0]);
  assert.equal(u.origin + u.pathname, "https://api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancDetail");
  assert.equal(u.searchParams.get("cond[HSSPLY_ADRES::LIKE]"), "부산광역시 해운대구");
  assert.equal(u.searchParams.get("cond[HOUSE_SECD::EQ]"), "01");
  assert.equal(u.searchParams.get("cond[RCRIT_PBLANC_DE::GTE]"), "2024-11-16");
  assert.equal(u.searchParams.get("cond[RCRIT_PBLANC_DE::LTE]"), "2026-11-16");
  assert.equal(u.searchParams.get("serviceKey"), FAKE_KEY);
});

test("공고 → 주택형 조회 → 점 · 제외 집계 · 페이지 넘김(matchCount)", async () => {
  const notices = Array.from({ length: 130 }, (_, i) => notice({ HOUSE_MANAGE_NO: String(i), PBLANC_NO: String(i), HOUSE_NM: `단지${i}`, RCRIT_PBLANC_DE: `2026-0${(i % 9) + 1}-01` }));
  const models = {};
  notices.forEach((n, i) => { models[n.HOUSE_MANAGE_NO] = i % 10 === 0 ? [model("059.9900A", 80, 70000)] : [model("084.9800A", 112.4, 90000 + i)]; });
  const r = await S.fetchSupply("부산광역시 해운대구", FAKE_KEY, { today: TODAY, fetchImpl: fakeApi({ notices, models }) });
  assert.equal(r.notices, 130);
  assert.equal(r.points.length, 117);
  assert.equal(r.excluded.no84, 13);
  assert.ok(r.points.every((p, i, a) => i === 0 || a[i - 1].date <= p.date)); // 날짜순
});

test("인증 오류(활용신청 미승인 등)는 오류로 · 메시지에 키 없음", async () => {
  const r = await S.getSupply("부산광역시 해운대구", { key: FAKE_KEY, today: TODAY, cacheDir: tmpDir(), fetchImpl: fakeApi({ authFail: true }) });
  assert.equal(r.status, "error");
  assert.match(r.message, /활용신청/);
  assert.ok(!JSON.stringify(r).includes("TEST") && !JSON.stringify(r).includes("abc"));
});

test("지역이 정확히 하나로 맞지 않으면 청약홈 API를 부르지 않는다", async () => {
  const log = [];
  const r = await S.getSupply("부산 해운대구", { key: FAKE_KEY, today: TODAY, cacheDir: tmpDir(), fetchImpl: fakeApi({ log }) });
  assert.equal(r.status, "ambiguous");
  assert.ok(log.every(u => u.includes("StanReginCd")));
});

test("같은 조회는 하루 동안 다시 부르지 않는다", async () => {
  const dir = tmpDir();
  let t = Date.parse("2026-11-16T09:00:00Z");
  const log = [];
  const opts = { key: FAKE_KEY, today: TODAY, cacheDir: dir, now: () => t, fetchImpl: fakeApi({ notices: [notice()], models: { 2025000001: [model("084.9800A", 112.4, 95000)] }, log }) };
  try {
    const a = await S.getSupply("부산광역시 해운대구", opts);
    const calls = log.filter(u => u.includes("odcloud")).length;
    t += 20 * 3600e3; R.clearCache();
    const b = await S.getSupply("부산광역시 해운대구", opts);
    assert.equal(a.cached, false);
    assert.equal(b.cached, true);
    assert.equal(log.filter(u => u.includes("odcloud")).length, calls);
    assert.equal(b.points[0].price, a.points[0].price);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("보고서 · 차트: 서버가 준 점을 그대로 쓰고, 다시 계산하지 않는다", () => {
  const A = { name: PRESETS.A.name, site: PRESETS.A.site, ...toInput(PRESETS.A) };
  const supply = { status: "ok", points: [{ label: "가", date: "2025-09-19", ym: "2025-09", price: 4051.4, types: 5 }, { label: "나", date: "2026-10-16", ym: "2026-10", price: 2322.2, types: 3 }], notices: 3, excluded: { rent: 0, no84: 1, error: 0 }, fetchedAt: "2026-11-16T00:00:00Z", source: S.SOURCE };
  const R2 = Report.buildReport(A, 1, { status: "ok", name: "부산광역시 해운대구", code: "26350" }, { name: "부산광역시 해운대구", code: "26350", months: ["202611"], silv: {}, rent: {}, supply });
  assert.equal(R2.marketChart.points, supply.points);
  assert.equal(R2.marketChart.notices, 3);
  const svg = Charts.marketMargin(R2.marketChart);
  assert.equal((svg.match(/<circle /g) || []).length, 2);
  assert.match(svg, /4,051만원\/평/); // 툴팁 = 받은 값 그대로
  assert.ok(R2.unverified.some(t => t.includes("분양최고금액 기준")));
});

test("공급가 조회 실패면 7장에 미확인과 이유", () => {
  const A = { name: "x", site: "x", ...toInput(PRESETS.A) };
  const R2 = Report.buildReport(A, 1, { status: "ok", name: "부산광역시 해운대구", code: "26350" }, { name: "부산광역시 해운대구", code: "26350", months: ["202611"], silv: {}, rent: {}, supply: { status: "error", message: "청약홈 API 인증 오류" } });
  assert.deepEqual(R2.marketChart.points, []);
  assert.ok(R2.unverified.some(t => t.includes("인근 신규 공급 평당가 미확인") && t.includes("인증 오류")));
});
