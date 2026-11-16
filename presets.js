// 임시 값 A·B·C (화면 버튼과 검산 테스트에서 함께 사용)
// units: [이름, 전용㎡, 공급평, 세대수] · 금액 단위: 평당가 만원, 나머지 억원
(function (root) {
  const PRESETS = {
    A: { name: "해운대 그린테라스", site: "부산광역시 해운대구",
         units: [["59형", 59.9, 25.6, 200], ["84형", 84.9, 34.6, 320]],
         price: 2420, retail: 150, other: 175, fixed: 3815.0, pf: 2450, pfCost: 480, sub: 400 },
    B: { name: "영통 센트럴파크", site: "경기도 수원시 영통구",
         units: [["59형", 59.8, 25.4, 300], ["84형", 84.9, 34.3, 480]],
         price: 2650, retail: 180, other: 260, fixed: 6296.4, pf: 4100, pfCost: 820, sub: 600 },
    C: { name: "유성 리버뷰", site: "대전광역시 유성구",
         units: [["74형", 74.6, 30.8, 140], ["84형", 84.9, 34.5, 240]],
         price: 1980, retail: 90, other: 120, fixed: 2461.2, pf: 1650, pfCost: 330, sub: 260 },
  };

  // 프리셋을 계산 모듈이 받는 입력 형태로 바꿉니다.
  function toInput(p) {
    return {
      units: p.units.map(([name, excl, supply, households]) => ({ name, excl, supply, households })),
      price: p.price, retail: p.retail, other: p.other, fixed: p.fixed,
      pf: p.pf, pfCost: p.pfCost, sub: p.sub,
    };
  }

  const out = { PRESETS, toInput };
  if (typeof module !== "undefined" && module.exports) module.exports = out;
  else root.Presets = out;
})(this);
