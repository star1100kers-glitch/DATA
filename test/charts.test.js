// SVG 차트 검산 (Node 내장 node:test) — 이미 계산된 값만 그리는지, 자료가 없으면 null인지
const test = require("node:test");
const assert = require("node:assert/strict");
const Calc = require("../calc");
const Charts = require("../charts");
const Report = require("../report");
const { PRESETS, toInput } = require("../presets");

const A = toInput(PRESETS.A);
const rawA = { name: PRESETS.A.name, site: PRESETS.A.site, ...A };
const count = (s, re) => (s.match(re) || []).length;

test("폭포 단계(calc): 분양수입 → 변동비 → 고정비 → 기타유입 → 기말현금, 마지막 = 기말현금", () => {
  const st = Calc.waterfallSteps(A, 1);
  assert.deepEqual(st.map(s => s.label), ["분양수입", "변동비", "고정비", "기타유입", "기말현금"]);
  assert.equal(st[4].to, Calc.endingCash(A, 1));
  assert.equal(st[3].to.toFixed(6), st[4].to.toFixed(6));       // 이어진 막대 끝 = 기말현금
  for (let i = 1; i <= 3; i++) assert.equal(st[i].from, st[i - 1].to); // 단계가 이어짐
  assert.equal(st[1].value.toFixed(1), "-48.1");                // 학교용지 32.5 + 분양대행 15.6
});

test("폭포 SVG: 막대 5개 · 값 표시 · 천단위 콤마 · 음수 기호", () => {
  const svg = Charts.waterfall(Calc.waterfallSteps(A, 1));
  assert.equal(count(svg, /<rect /g), 5);
  for (const t of [">4,068.5<", ">−48.1<", ">−3,815.0<", ">+175.0<", ">380.3<"]) assert.ok(svg.includes(t), t);
  assert.ok(svg.includes(">억원<"));
});

test("차트는 다시 계산하지 않는다: 받은 value를 그대로 표시", () => {
  // 일부러 from/to와 맞지 않는 value를 넣어도, 표시는 value 그대로
  const steps = [
    { label: "가", kind: "total", value: 100, from: 0, to: 100 },
    { label: "나", kind: "down", value: -12.3, from: 100, to: 50 },
    { label: "다", kind: "total", value: 77.7, from: 0, to: 50 },
  ];
  const svg = Charts.waterfall(steps);
  assert.ok(svg.includes(">−12.3<"));
  assert.ok(svg.includes(">77.7<"));
  assert.ok(!svg.includes(">−50.0<") && !svg.includes(">50.0<"));
});

test("기말현금이 음수면 빨간 막대 · 빨간 값", () => {
  const st = Calc.waterfallSteps({ ...A, fixed: 5000 }, 1);
  const svg = Charts.waterfall(st);
  assert.match(svg, /class="bar-neg"/);
  assert.match(svg, /class="val neg"[^>]*>−804\.7</);
});

test("자료가 없으면 null (화면은 빈 축 대신 '자료 없음')", () => {
  assert.equal(Charts.waterfall(null), null);
  assert.equal(Charts.waterfall([]), null);
  assert.equal(Charts.marketMargin({ points: [], plan: 2420, repay: 1934 }), null);
  assert.equal(Charts.marketMargin({ points: [{ ym: "2026-01", price: 2300 }], plan: null }), null);
});

test("시장 대비 여유 SVG: 점 · 계획가 선 · 상환 한계 선 · 여유 구간", () => {
  const svg = Charts.marketMargin({
    points: [{ label: "가단지", ym: "2026-03", price: 2380 }, { label: "나단지", ym: "2026-07", price: 2510 }],
    plan: 2420, repay: 1934.2,
  });
  assert.equal(count(svg, /<circle /g), 2);
  assert.match(svg, /계획가 2,420/);
  assert.match(svg, /상환 한계 1,934/);
  assert.match(svg, /class="band-ok"/);
  assert.match(svg, /line-plan/);
  assert.match(svg, /line-repay/);
});

test("보고서: 공급가 자료가 없으면 점 0개, 계획가 · 상환 한계는 이미 계산된 값", () => {
  const R = Report.buildReport(rawA, 1, { status: "ok", name: "부산광역시 해운대구", code: "26350" }, null);
  assert.deepEqual(R.marketChart.points, []);
  assert.equal(R.marketChart.plan, 2420);
  assert.equal(R.marketChart.repay, Calc.limits(A).repay.price);
  assert.equal(Charts.marketMargin(R.marketChart), null);
  assert.deepEqual(R.feasibility.waterfall, Calc.waterfallSteps(A, 1));
});

test("보고서: 입력이 비면 폭포 단계도 없음", () => {
  const R = Report.buildReport({ ...rawA, fixed: null }, 1);
  assert.equal(R.feasibility.ok, false);
  assert.equal(R.feasibility.waterfall, undefined);
  assert.equal(R.marketChart.repay, null);
});
