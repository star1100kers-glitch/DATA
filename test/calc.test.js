// 검산 테스트 (Node 내장 node:test 사용 · 실행: npm test)
const test = require("node:test");
const assert = require("node:assert/strict");
const Calc = require("../calc");
const { PRESETS, toInput } = require("../presets");

const A = toInput(PRESETS.A);

// 샘플 A · 분양률 100%: 기말현금 +380.3억 · DSCR 1.27 · LTV 60.2%
test("샘플 A 기말현금 +380.3억", () => {
  assert.equal(Calc.endingCash(A, 1).toFixed(1), "380.3");
});

test("샘플 A 만기 누적 DSCR 1.27", () => {
  assert.equal(Calc.maturityDscr(A, 1).toFixed(2), "1.27");
});

test("샘플 A LTV 60.2%", () => {
  assert.equal((Calc.ltv(A) * 100).toFixed(1), "60.2");
});

// 중간값 검산: 공급면적 16,192평 · 세대수 520 · 분양수입 4,068.5억
test("샘플 A 중간값", () => {
  assert.equal(Calc.totalSupplyArea(A.units).toFixed(1), "16192.0");
  assert.equal(Calc.totalHouseholds(A.units), 520);
  assert.equal(Calc.salesRevenue(A, 1).toFixed(1), "4068.5");
});

// 한계선 · 샘플 A: 기말현금 0 → 90.5% · 2,183만원 / 상환 한계 → 80.6% · 1,934만원
test("샘플 A 기말현금 0 한계: 90.5% · 2,183만원", () => {
  const L = Calc.limits(A);
  assert.equal((L.zero.rate * 100).toFixed(1), "90.5");
  assert.equal(Math.round(L.zero.price), 2183);
});

test("샘플 A 상환 한계: 80.6% · 1,934만원", () => {
  const L = Calc.limits(A);
  assert.equal((L.repay.rate * 100).toFixed(1), "80.6");
  assert.equal(Math.round(L.repay.price), 1934);
});

// 역산한 한계값을 다시 넣으면 목표 기말현금이 나와야 한다
test("한계값을 넣으면 기말현금이 0 / −후순위로 돌아온다", () => {
  const L = Calc.limits(A);
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);
  near(Calc.endingCash(A, L.zero.rate), 0);
  near(Calc.endingCash(A, L.repay.rate), -A.sub);
  near(Calc.endingCash({ ...A, price: L.zero.price }, 1), 0);
  near(Calc.endingCash({ ...A, price: L.repay.price }, 1), -A.sub);
});

test("민감도 표: 6행 × 7열, 칸 값과 상환 판정이 맞다", () => {
  const S = Calc.sensitivity(A);
  assert.deepEqual(S.rows.map(r => Math.round(r.rate * 100)), [75, 80, 85, 90, 95, 100]);
  assert.deepEqual(S.columns.map(c => c.price), [1920, 2020, 2120, 2220, 2320, 2420, 2520]);
  // 100% · 계획 평당가 칸은 본 계산과 같다
  assert.equal(S.rows[5].cells[5].endingCash, Calc.endingCash(A, 1));
  // 상환 한계가 80.6%이므로 계획 평당가 열에서 80%는 불가, 85%는 가능
  assert.equal(S.rows[1].cells[5].canRepay, false);
  assert.equal(S.rows[2].cells[5].canRepay, true);
  // 상환 한계 평당가가 1,934만원이므로 100% 행에서 1,920만원은 불가, 2,020만원은 가능
  assert.equal(S.rows[5].cells[0].canRepay, false);
  assert.equal(S.rows[5].cells[1].canRepay, true);
});

// LTV는 분양률과 무관하게 100% 기준 분양수입을 쓴다
test("분양률을 바꿔도 LTV는 그대로, 분양수입은 비례", () => {
  assert.equal(Calc.salesRevenue(A, 0.8), Calc.salesRevenue(A, 1) * 0.8);
  assert.equal(Calc.feasibility(A, 0.8).ltv, Calc.ltv(A));
  assert.ok(Calc.endingCash(A, 0.8) < Calc.endingCash(A, 1));
});
