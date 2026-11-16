// 사업계획서 7개 장 구성 검산 (Node 내장 node:test)
const test = require("node:test");
const assert = require("node:assert/strict");
const Report = require("../report");
const { PRESETS, toInput } = require("../presets");

// 프리셋을 화면 입력 형태(raw)로
const rawOf = p => ({ name: p.name, site: p.site, ...toInput(p) });
const A = rawOf(PRESETS.A);
const EMPTY = {
  name: "", site: "", units: [{ name: "", excl: null, supply: null, households: null }],
  price: null, retail: null, other: null, fixed: null, pf: null, pfCost: null, sub: null,
};

test("2장 시장 분석은 항상 '자료 없음 — 공공데이터 확인 필요'", () => {
  const R = Report.buildReport(A);
  assert.equal(R.market.ok, false);
  assert.equal(R.market.message, "자료 없음 — 공공데이터 확인 필요");
});

test("빈 입력이면 1·3·4·5·6장 모두 자료 없음, 숫자를 만들지 않는다", () => {
  const R = Report.buildReport(EMPTY);
  assert.equal(R.overview.empty, true);
  for (const k of ["feasibility", "funding", "sensitivity", "risks"]) {
    assert.equal(R[k].ok, false, k);
    assert.equal(R[k].result, undefined, k);
  }
  assert.equal(R.overview.supplyArea, null);
  assert.equal(R.overview.price, null);
});

test("고정비만 비면 0으로 채우지 않고 3장부터 자료 없음 + 빠진 항목 안내", () => {
  const R = Report.buildReport({ ...A, fixed: null });
  assert.equal(R.feasibility.ok, false);
  assert.deepEqual(R.feasibility.lack, ["고정비"]);
  assert.equal(R.funding.ok, false);
  assert.equal(R.overview.price, 2420); // 1장은 있는 값만 보여줌
});

test("후순위만 비면 3장은 계산, 4~6장은 자료 없음", () => {
  const R = Report.buildReport({ ...A, sub: null });
  assert.equal(R.feasibility.ok, true);
  assert.equal(R.feasibility.result.endingCash.toFixed(1), "380.3");
  assert.deepEqual(R.funding.lack, ["후순위"]);
});

test("샘플 A 자동 문장", () => {
  const R = Report.buildReport(A);
  assert.equal(R.sensitivity.sentence, "평당 1,935만원 / 분양률 80.6% 이상이면 상환 가능");
});

test("샘플 A 4장: DSCR 1.27 · LTV 60.2% · 상환 가능 · 여유 780.3억", () => {
  const P = Report.buildReport(A).funding;
  assert.equal(P.result.dscr.toFixed(2), "1.27");
  assert.equal((P.result.ltv * 100).toFixed(1), "60.2");
  assert.equal(P.canRepay, true);
  assert.equal(P.margin.toFixed(1), "780.3");
});

test("샘플 A 6장: 두 한계선에서 짚은 리스크 4개", () => {
  const items = Report.buildReport(A).risks.items;
  assert.deepEqual(items.map(i => i.title), ["분양률 하락", "분양가 하락", "분양률 · 분양가 동시 하락", "비용 초과"]);
  assert.match(items[0].finding, /80\.6%/);
  assert.match(items[0].finding, /90\.5%/);
  assert.match(items[1].finding, /1,934만원/);
  assert.match(items[1].finding, /2,183만원/);
  assert.ok(items.every(i => i.mitigation.length > 0));
});

test("7장에 범위 밖 항목과 빈 입력이 적힌다", () => {
  assert.ok(Report.buildReport(A).unverified.includes("월별 자금수지 · IRR은 이 앱의 범위 밖"));
  const R = Report.buildReport({ ...A, pf: null });
  assert.ok(R.unverified.some(t => t.includes("비어 있는 입력") && t.includes("본PF")));
});

test("천단위 콤마와 음수 표기", () => {
  assert.equal(Report.f(1234567.89, 1), "1,234,567.9");
  assert.equal(Report.f(-1227.1, 1), "−1,227.1");
  assert.equal(Report.f(-0.01, 1), "0.0");
});
