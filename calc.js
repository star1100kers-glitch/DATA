// 사업수지 계산 모듈 (화면과 분리)
// 금액 단위: 억원 · 평당가: 만원 · 면적: 평 · 분양률: 0~1 (1 = 100%)
// 브라우저에서는 window.Calc, Node에서는 require("./calc") 로 사용합니다.
(function (root) {
  "use strict";

  // 고정 가정값
  const SCHOOL_LEVY_RATE = 0.008; // 학교용지부담금: 분양수입의 0.8%
  const AGENCY_FEE_PER_UNIT = 300 / 10000; // 분양대행 수수료: 세대당 300만원 = 0.03억원

  // 주택형 표에서 공급면적 합계(평)를 구합니다. 각 행의 공급평 × 세대수를 더한 값입니다.
  function totalSupplyArea(units) {
    return units.reduce((sum, u) => sum + (Number(u.supply) || 0) * (Number(u.households) || 0), 0);
  }

  // 주택형 표에서 세대수 합계를 구합니다.
  function totalHouseholds(units) {
    return units.reduce((sum, u) => sum + (Number(u.households) || 0), 0);
  }

  // 분양수입(억원) = (공급면적 × 평당가 ÷ 10,000 + 상가) × 분양률
  // 평당가가 만원 단위이므로 10,000으로 나눠 억원으로 맞춥니다.
  function salesRevenue(input, rate) {
    const aptRevenue = (totalSupplyArea(input.units) * input.price) / 10000;
    return (aptRevenue + input.retail) * rate;
  }

  // 분양률에 따라 팔린 세대 수를 구합니다. (세대수 합계 × 분양률)
  function soldHouseholds(input, rate) {
    return totalHouseholds(input.units) * rate;
  }

  // 기말현금(억원) = 분양수입 × (1 − 학교용지 0.8%) − 팔린 세대 × 분양대행 300만원 + 기타유입 − 고정비
  function endingCash(input, rate) {
    const revenue = salesRevenue(input, rate);
    return revenue * (1 - SCHOOL_LEVY_RATE)
      - soldHouseholds(input, rate) * AGENCY_FEE_PER_UNIT
      + input.other
      - input.fixed;
  }

  // 만기 누적 DSCR = 1 + (기말현금 + 후순위) ÷ (본PF + 본PF 금융비용)
  function maturityDscr(input, rate) {
    return 1 + (endingCash(input, rate) + input.sub) / (input.pf + input.pfCost);
  }

  // LTV = 본PF ÷ 분양률 100%일 때의 분양수입 (분양률과 무관하게 항상 100% 기준)
  function ltv(input) {
    return input.pf / salesRevenue(input, 1);
  }

  // 한 번에 모든 결과를 계산합니다. 화면 표시와 검산에 함께 씁니다.
  function feasibility(input, rate) {
    const revenue = salesRevenue(input, rate);
    const sold = soldHouseholds(input, rate);
    return {
      rate,
      supplyArea: totalSupplyArea(input.units),
      households: totalHouseholds(input.units),
      soldHouseholds: sold,
      revenue,
      schoolLevy: revenue * SCHOOL_LEVY_RATE,
      agencyFee: sold * AGENCY_FEE_PER_UNIT,
      endingCash: endingCash(input, rate),
      dscr: maturityDscr(input, rate),
      ltv: ltv(input),
    };
  }

  // 사업수지 폭포 차트용 단계: 분양수입 → 변동비 → 고정비 → 기타유입 → 기말현금
  // 변동비 = 학교용지 + 분양대행. 각 단계의 시작(from)·끝(to)을 여기서 계산해 두고,
  // 차트는 이 값을 그리기만 합니다. 마지막 단계의 값은 endingCash()와 같습니다.
  function waterfallSteps(input, rate) {
    const r = feasibility(input, rate);
    const variable = r.schoolLevy + r.agencyFee;
    const afterVar = r.revenue - variable;
    const afterFixed = afterVar - input.fixed;
    const afterOther = afterFixed + input.other;
    return [
      { key: "revenue", label: "분양수입", kind: "total", value: r.revenue, from: 0, to: r.revenue },
      { key: "variable", label: "변동비", note: "학교용지 + 분양대행", kind: "down", value: -variable, from: r.revenue, to: afterVar },
      { key: "fixed", label: "고정비", kind: "down", value: -input.fixed, from: afterVar, to: afterFixed },
      { key: "other", label: "기타유입", kind: "up", value: input.other, from: afterFixed, to: afterOther },
      { key: "endingCash", label: "기말현금", kind: "total", value: r.endingCash, from: 0, to: r.endingCash },
    ];
  }

  // 상환 가능 여부: 기말현금이 −후순위 이상이면 본PF를 전액 상환할 수 있다고 봅니다.
  function canRepay(input, rate) {
    return endingCash(input, rate) >= -input.sub;
  }

  // 평당가만 바꾼 입력을 만듭니다. (원본 입력은 건드리지 않음)
  function withPrice(input, price) {
    return Object.assign({}, input, { price });
  }

  // 기말현금이 목표값(target)이 되는 분양률을 구합니다. (0~1, 평당가는 계획값)
  // 기말현금은 분양률에 대해 직선이므로 바로 풀 수 있습니다.
  //   기말현금 = 분양률 × [분양수입100% × (1 − 0.8%) − 세대수 × 0.03억] + 기타유입 − 고정비
  // 분양률을 올려도 현금이 늘지 않으면(기울기 ≤ 0) 해가 없으므로 NaN을 돌려줍니다.
  function breakevenRate(input, target) {
    const slope = salesRevenue(input, 1) * (1 - SCHOOL_LEVY_RATE) - totalHouseholds(input.units) * AGENCY_FEE_PER_UNIT;
    if (!(slope > 0)) return NaN;
    return (target - input.other + input.fixed) / slope;
  }

  // 기말현금이 목표값(target)이 되는 평당가(만원)를 구합니다. 분양률은 rate (기본 100%)로 고정합니다.
  //   목표 = 분양률 × [(공급면적 × 평당가 ÷ 10,000 + 상가) × (1 − 0.8%) − 세대수 × 0.03억] + 기타유입 − 고정비
  // 를 평당가에 대해 거꾸로 풉니다.
  function breakevenPrice(input, target, rate = 1) {
    const area = totalSupplyArea(input.units);
    if (!(area > 0) || !(rate > 0)) return NaN;
    const perRate = (target - input.other + input.fixed) / rate + totalHouseholds(input.units) * AGENCY_FEE_PER_UNIT;
    const revenueNeeded = perRate / (1 - SCHOOL_LEVY_RATE); // 필요한 분양수입(100% 기준, 상가 포함)
    return ((revenueNeeded - input.retail) * 10000) / area;
  }

  // 두 한계선을 한 번에 구합니다.
  //  - zero: 기말현금이 0이 되는 분양률 · 평당가
  //  - repay: 기말현금이 −후순위가 되는 분양률 · 평당가 (= PF 전액 상환 한계)
  // 평당가 한계는 분양률 100% 기준입니다.
  function limits(input) {
    return {
      zero: { rate: breakevenRate(input, 0), price: breakevenPrice(input, 0, 1) },
      repay: { rate: breakevenRate(input, -input.sub), price: breakevenPrice(input, -input.sub, 1) },
    };
  }

  // 민감도 표를 만듭니다.
  //  - 행: 분양률 (기본 75% ~ 100%, 5%p 간격)
  //  - 열: 계획 평당가 대비 증감(만원) (기본 −500 ~ +100, 100만원 간격)
  //  - 칸: 기말현금과 상환 가능 여부
  function sensitivity(input, opts = {}) {
    const rates = opts.rates || [0.75, 0.80, 0.85, 0.90, 0.95, 1.00];
    const deltas = opts.priceDeltas || [-500, -400, -300, -200, -100, 0, 100];
    const columns = deltas.map(d => ({ delta: d, price: input.price + d }));
    const rows = rates.map(rate => ({
      rate,
      cells: columns.map(c => {
        const scenario = withPrice(input, c.price);
        return { endingCash: endingCash(scenario, rate), canRepay: canRepay(scenario, rate) };
      }),
    }));
    return { columns, rows };
  }

  const Calc = {
    SCHOOL_LEVY_RATE, AGENCY_FEE_PER_UNIT,
    totalSupplyArea, totalHouseholds, salesRevenue, soldHouseholds,
    endingCash, maturityDscr, ltv, feasibility,
    canRepay, breakevenRate, breakevenPrice, limits, sensitivity, waterfallSteps,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = Calc;
  else root.Calc = Calc;
})(this);
