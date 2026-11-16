// 사업계획서 7개 장 구성 모듈 (화면 없이 데이터만 만듭니다 · 계산은 calc.js)
// 원칙: 비어 있는 입력은 0으로 채우지 않고 "자료 없음"으로 남깁니다.
// 브라우저에서는 window.Report, Node에서는 require("./report") 로 사용합니다.
(function (root) {
  "use strict";
  const isNode = typeof module !== "undefined" && module.exports;
  const Calc = isNode ? require("./calc") : root.Calc;
  const Market = isNode ? require("./market") : root.Market;
  const KIND_LABEL = Market.KIND_LABEL;

  // 입력 항목 이름 (빠진 항목 안내에 사용)
  const LABELS = {
    name: "사업명", site: "사업대상지", units: "주택형(공급평·세대수)",
    price: "평당가", retail: "상가", other: "기타유입", fixed: "고정비",
    pf: "본PF", pfCost: "본PF 금융비용", sub: "후순위",
  };
  const CASH_KEYS = ["units", "price", "retail", "other", "fixed"]; // 사업수지에 필요한 입력
  const FUND_KEYS = [...CASH_KEYS, "pf", "pfCost", "sub"];          // 자금조달·민감도·리스크에 필요한 입력

  const MARKET_EMPTY = "자료 없음 — 공공데이터 확인 필요";
  const OUT_OF_SCOPE = "월별 자금수지 · IRR은 이 앱의 범위 밖";

  const isNum = v => typeof v === "number" && isFinite(v);

  // 숫자를 천단위 콤마 문자열로 바꿉니다. 음수는 "−" 기호를 붙입니다.
  function f(n, d = 0) {
    const s = Math.abs(n).toLocaleString("ko-KR", { minimumFractionDigits: d, maximumFractionDigits: d });
    const isZero = !/[1-9]/.test(s);
    return (n < 0 && !isZero ? "−" : "") + s;
  }
  // 0~1 비율을 "80.6%" 형태로 바꿉니다.
  const pct = (r, d = 1) => f(r * 100, d) + "%";

  // 주택형 표를 정리합니다. 완전히 빈 행은 버리고, 남은 행은 공급평·세대수가 모두 있어야 유효합니다.
  function cleanUnits(units = []) {
    const rows = units.filter(u =>
      (u.name && String(u.name).trim()) || isNum(u.excl) || isNum(u.supply) || isNum(u.households));
    const complete = rows.length > 0
      && rows.every(u => isNum(u.supply) && isNum(u.households))
      && Calc.totalSupplyArea(rows) > 0;
    return { rows, complete };
  }

  // 입력 항목 하나가 비었는지 확인합니다.
  function isMissing(raw, key) {
    if (key === "units") return !cleanUnits(raw.units).complete;
    if (key === "name" || key === "site") return !(raw[key] && String(raw[key]).trim());
    return !isNum(raw[key]);
  }

  // 주어진 항목 중 빠진 것의 이름 목록을 돌려줍니다.
  function lack(raw, keys) {
    return keys.filter(k => isMissing(raw, k)).map(k => LABELS[k]);
  }

  // 화면 입력(빈칸은 null)을 계산 모듈 입력으로 바꿉니다. 필요한 항목이 다 있을 때만 호출합니다.
  function toInput(raw) {
    const num = k => (isNum(raw[k]) ? raw[k] : 0);
    return {
      units: cleanUnits(raw.units).rows,
      price: num("price"), retail: num("retail"), other: num("other"), fixed: num("fixed"),
      pf: num("pf"), pfCost: num("pfCost"), sub: num("sub"),
    };
  }

  // 표 아래 자동 문장: "평당 OOO만원 / 분양률 OO% 이상이면 상환 가능"
  // "이상이면"이 참이 되도록 한계값은 올림합니다. (평당가 1만원, 분양률 0.1%p 단위)
  function repaySentence(input) {
    const L = Calc.limits(input);
    if (!isFinite(L.repay.price) || !isFinite(L.repay.rate)) return null;
    const pUp = Math.ceil(L.repay.price - 1e-9);
    const rUp = Math.ceil(L.repay.rate * 1000 - 1e-9) / 10;
    if (rUp > 100) return `계획 평당가로는 분양률 100%에서도 상환 불가 — 평당 ${f(pUp)}만원 이상(분양률 100%)이어야 상환 가능`;
    return `평당 ${f(pUp)}만원 / 분양률 ${f(rUp, 1)}% 이상이면 상환 가능`;
  }

  // 6장: 두 한계선(기말현금 0 · 상환 한계)에서 거꾸로 짚은 리스크와 완화 방안
  function buildRisks(input, rate) {
    const L = Calc.limits(input);
    const H = Calc.totalHouseholds(input.units);
    const area = Calc.totalSupplyArea(input.units);
    const ec = Calc.endingCash(input, rate);
    const sub = input.sub, plan = input.price;
    // 분양률 1.0(100%p) 변화당 기말현금 변화(억원)
    const perRate = Calc.salesRevenue(input, 1) * (1 - Calc.SCHOOL_LEVY_RATE) - H * Calc.AGENCY_FEE_PER_UNIT;
    // 평당가 10만원 변화당 기말현금 변화(억원)
    const per10 = (10 * area / 10000) * (1 - Calc.SCHOOL_LEVY_RATE) * rate;
    const items = [];

    // ① 분양률 하락
    {
      const r = L.repay.rate, z = L.zero.rate;
      let finding;
      if (r > rate) {
        finding = `계획 분양률 ${pct(rate, 0)}에서도 기말현금이 −후순위에 못 미쳐 PF 전액 상환이 불가합니다. 상환 한계 분양률은 ${pct(r)}입니다.`;
      } else {
        finding = `분양률이 ${pct(r)} 아래로 내려가면 PF 전액 상환이 불가합니다. 계획 ${pct(rate, 0)} 대비 여유는 ${f((rate - r) * 100, 1)}%p, 약 ${f(Math.floor((rate - r) * H))}세대입니다.`;
        finding += z <= rate
          ? ` 분양률 ${pct(z)} 미만부터는 기말현금이 음수가 되어 후순위가 손실을 부담합니다.`
          : ` 계획 분양률에서도 기말현금이 음수라 후순위가 손실을 부담합니다.`;
      }
      items.push({
        title: "분양률 하락", ok: r <= rate, finding,
        mitigation: [
          `고정비 100억원 절감 또는 후순위 100억원 증액 시 상환 한계 분양률 ${f(100 / perRate * 100, 1)}%p 하락`,
          `분양률 ${pct(r)}를 관리 하한으로 두고 분양 실적을 대주단과 정기 공유 · 미달 시 조치 기준을 사전 약정`,
        ],
      });
    }

    // ② 분양가(평당가) 하락
    {
      const p = L.repay.price, pz = L.zero.price;
      let finding;
      const mitigation = [`평당가 10만원 변동 = 기말현금 ${f(per10, 1)}억원 변동 (분양률 ${pct(rate, 0)} 기준)`];
      if (p > plan) {
        finding = `분양률 100%여도 평당가가 ${f(p)}만원 이상이어야 상환 가능합니다. 계획 평당가 ${f(plan)}만원보다 ${f(p - plan)}만원 높습니다.`;
        mitigation.push(`계획 평당가에서 상환 가능하려면 고정비 ${f(-sub - Calc.endingCash(input, 1), 1)}억원 절감 또는 동액 수입 증대 필요`);
      } else {
        finding = `평당가가 ${f(p)}만원 아래로 내려가면(분양률 100% 기준) PF 전액 상환이 불가합니다. 계획 ${f(plan)}만원 대비 ${f(p - plan)}만원(${f((p / plan - 1) * 100, 1)}%)까지 허용됩니다. 기말현금이 0이 되는 평당가는 ${f(pz)}만원입니다.`;
        mitigation.push(`할인 분양은 평당 ${f(Math.floor(plan - p))}만원 이내에서 결정하고, 그 이상은 대주단 사전 협의 대상으로 약정`);
      }
      items.push({ title: "분양가 하락", ok: p <= plan, finding, mitigation });
    }

    // ③ 분양률 · 분양가 동시 하락 (민감도 표 기준)
    {
      const S = Calc.sensitivity(input);
      const cells = S.rows.flatMap(r => r.cells);
      const okCount = cells.filter(c => c.canRepay).length;
      const combo = { ...input, price: plan - 100 };
      const ec2 = Calc.endingCash(combo, 0.9);
      const ok2 = Calc.canRepay(combo, 0.9);
      items.push({
        title: "분양률 · 분양가 동시 하락", ok: ok2,
        finding: `분양률 90% · 평당가 −100만원이 함께 오면 기말현금 ${f(ec2, 1)}억원으로 상환 ${ok2 ? "가능" : "불가"}합니다. 민감도 표 ${cells.length}칸 중 ${okCount}칸이 상환 가능합니다.`,
        mitigation: [
          "분양률과 평당가를 따로가 아니라 조합으로 관리 — 민감도 표의 상환 가능(초록) 영역 안에서 분양 전략 수립",
        ],
      });
    }

    // ④ 비용 초과 (계획 기준 기말현금이 곧 비용 증가 허용폭)
    {
      const okCost = ec + sub >= 0;
      const finding = okCost
        ? `계획 기준 기말현금은 ${f(ec, 1)}억원입니다. 고정비가 ${f(Math.max(ec, 0), 1)}억원 넘게 늘면 기말현금이 음수, ${f(ec + sub, 1)}억원 넘게 늘면 PF 전액 상환이 불가합니다.`
        : `계획 기준 기말현금 ${f(ec, 1)}억원으로 이미 −후순위(${f(-sub, 1)}억원)에 못 미칩니다. ${f(-sub - ec, 1)}억원의 비용 절감 또는 수입 증대가 필요합니다.`;
      items.push({
        title: "비용 초과", ok: okCost, finding,
        mitigation: [
          "고정비 내역(토지비·공사비·금융비 등) 검증과 공사비 증액 상한 약정 — 이 앱은 고정비를 총액으로만 받음",
        ],
      });
    }
    return items;
  }

  // 지역 확인 상태를 한 줄 설명으로 (7장 · 화면 공통)
  const REGION_REASON = {
    empty: "사업대상지 미입력",
    pending: "확인 중",
    nokey: "공공데이터 인증키(.env.local) 미설정",
    offline: "서버 없이 열려 조회 불가",
    notfound: "일치하는 시군구 없음",
    ambiguous: "정확히 하나로 맞는 시군구 없음 — 후보 중 선택 필요",
    error: "조회 실패",
  };

  // 7장: 확인하지 못한 것
  function buildUnverified(raw, region, market) {
    const list = [];
    if (market && market.ok) {
      const t1 = market.table1;
      const fails = t1.errors.length;
      if (fails) list.push(`실거래 조회 실패 ${fails}개월 — ${t1.errors.map(e => `${KIND_LABEL[e.kind]} ${e.ym.slice(0, 4)}.${e.ym.slice(4)}`).join(" · ")}`);
      list.push("실거래 최근 1~2개월은 신고 기한(계약 후 30일)이 지나지 않아 덜 집계될 수 있음");
      const sup = market.supply;
      if (!sup || sup.status !== "ok") list.push(`인근 신규 공급 평당가 미확인${sup && sup.message ? ` — ${sup.message}` : ""}`);
      else list.push("인근 신규 공급 평당가는 84㎡ 주택형의 분양최고금액 기준 — 옵션 · 발코니 확장비 · 실제 계약가는 반영 안 됨");
      list.push("청약 경쟁률 · 미분양 현황은 아직 반영하지 않음");
    } else {
      list.push("시장 분석 자료 — 실거래 · 분양가 · 청약 경쟁률 · 미분양 현황 (공공데이터 확인 필요)");
    }
    list.push(OUT_OF_SCOPE);
    if (!region || region.status !== "ok") {
      const why = region ? REGION_REASON[region.status] || region.status : "확인 안 함";
      list.push(`사업대상지 법정동코드 미확인 — ${why}${region && region.message ? ` (${region.message})` : ""}`);
    }
    const missing = lack(raw, Object.keys(LABELS));
    if (missing.length) list.push(`비어 있는 입력 — ${missing.join(" · ")}`);
    list.push(
      "학교용지 0.8% · 분양대행 세대당 300만원은 앱 고정 가정 — 사업장별 고지·계약 기준 확인 필요",
      "고정비는 총액 하나로만 입력 — 세부 내역 미검증",
      "분양률은 아파트와 상가에 같은 비율로 적용",
      "입력값(면적 · 평당가 · 차입 조건) 자체의 근거 자료는 앱에서 확인하지 않음",
    );
    return list;
  }

  // 사업계획서 전체를 만듭니다. raw의 빈칸은 null(또는 빈 문자열)입니다.
  // region: 서버의 지역 확인 결과 { status: "ok", name, code } 등 (없으면 미확인)
  // marketState: 서버에서 받은 실거래 달별 결과 (없으면 2장은 "자료 없음")
  function buildReport(raw, rate = 1, region = null, marketState = null) {
    const units = cleanUnits(raw.units);
    const cashLack = lack(raw, CASH_KEYS);
    const fundLack = lack(raw, FUND_KEYS);
    const input = toInput(raw);
    // 2장: 확인된 지역의 실거래가 있을 때만 표를 만듭니다. 84㎡ 분양가는 평당가가 있을 때만.
    const market = marketState && marketState.months && marketState.months.length
      ? { ok: true, name: marketState.name, code: marketState.code, loading: !marketState.done, supply: marketState.supply || null,
          ...Market.buildMarket(marketState, units.rows, isNum(raw.price) ? raw.price : null) }
      : { ok: false, message: MARKET_EMPTY };

    // 1장: 있는 값만 보여주고 없는 값은 null (화면에서 "자료 없음")
    const overview = {
      empty: ["name", "site", "units", "price", "retail"].every(k => isMissing(raw, k)) && units.rows.length === 0,
      name: isMissing(raw, "name") ? null : String(raw.name).trim(),
      site: isMissing(raw, "site") ? null : String(raw.site).trim(),
      units: units.rows,
      unitsComplete: units.complete,
      supplyArea: units.complete ? Calc.totalSupplyArea(units.rows) : null,
      households: units.complete ? Calc.totalHouseholds(units.rows) : null,
      price: isNum(raw.price) ? raw.price : null,
      retail: isNum(raw.retail) ? raw.retail : null,
      // 확인된 지역은 이름이 정확히 하나로 맞은 경우(status "ok")만 채웁니다.
      region: region || { status: "empty" },
      regionName: region && region.status === "ok" ? region.name : null,
      regionCode: region && region.status === "ok" ? region.code : null,
    };

    const feasibility = cashLack.length
      ? { ok: false, lack: cashLack }
      : { ok: true, input, result: Calc.feasibility(input, rate), waterfall: Calc.waterfallSteps(input, rate) };

    let funding, sensitivity, risks;
    if (fundLack.length) {
      funding = sensitivity = risks = { ok: false, lack: fundLack };
    } else {
      const result = Calc.feasibility(input, rate);
      funding = {
        ok: true, input, result,
        debt: input.pf + input.pfCost,
        canRepay: Calc.canRepay(input, rate),
        margin: result.endingCash + input.sub,
      };
      sensitivity = {
        ok: true, input,
        limits: Calc.limits(input),
        table: Calc.sensitivity(input),
        sentence: repaySentence(input),
      };
      risks = { ok: true, items: buildRisks(input, rate) };
    }

    // 차트 ① 시장 대비 여유: 점(인근 신규 공급 평당가)은 공급가 자료가 연결될 때만 채워집니다.
    //  분양권 전매가는 프리미엄이 붙은 거래가라 "신규 공급가"로 쓰지 않습니다.
    const supply = marketState && marketState.supply;
    const marketChart = {
      status: supply ? supply.status : null,          // ok · loading · error · null(조회 안 함)
      message: supply && supply.message ? supply.message : null,
      points: supply && Array.isArray(supply.points) ? supply.points : [],
      notices: supply && typeof supply.notices === "number" ? supply.notices : null,
      excluded: supply && supply.excluded ? supply.excluded : null,
      window: supply && supply.window ? supply.window : null,
      source: supply && supply.source ? supply.source : null,
      fetchedAt: supply && supply.fetchedAt ? supply.fetchedAt : null,
      plan: isNum(raw.price) ? raw.price : null,
      repay: sensitivity.ok && isFinite(sensitivity.limits.repay.price) ? sensitivity.limits.repay.price : null,
    };

    return {
      rate,
      marketChart,
      missing: lack(raw, Object.keys(LABELS)),
      overview,
      market,
      feasibility, funding, sensitivity, risks,
      unverified: buildUnverified(raw, region, market),
    };
  }

  const Report = { LABELS, MARKET_EMPTY, REGION_REASON, OUT_OF_SCOPE, f, pct, cleanUnits, isMissing, lack, toInput, repaySentence, buildRisks, buildReport };
  if (typeof module !== "undefined" && module.exports) module.exports = Report;
  else root.Report = Report;
})(this);
