// 실거래(분양권전매 · 전월세) 집계 모듈 — 서버와 화면이 함께 씀 (네트워크·인증키 없음)
// 근거: 국토교통부 "아파트 분양권전매 실거래가 자료" · "아파트 전월세 실거래가 자료" 오픈API 활용가이드
(function (root) {
  "use strict";

  const MONTHS = 12;                       // 최근 12개월
  const BAND84 = { min: 83, max: 86 };     // "84㎡" = 전용 83㎡ 이상 86㎡ 미만
  const in84 = a => a !== null && a >= BAND84.min && a < BAND84.max;
  const KIND_LABEL = { silv: "분양권", rent: "전월세" };

  // 숫자 읽기: "95,815" → 95815, 빈칸 → null
  const num = s => { const n = parseFloat(String(s == null ? "" : s).replace(/,/g, "").trim()); return isFinite(n) ? n : null; };
  const blank = s => !String(s == null ? "" : s).trim();

  // 오늘이 속한 달을 포함한 최근 n개월(YYYYMM)을 오래된 달부터 돌려줍니다.
  function recentMonths(today = new Date(), n = MONTHS) {
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      out.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`);
    }
    return out;
  }

  // XML 특수문자 되돌리기
  const decode = s => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

  // XML 응답에서 결과코드 · 전체 건수 · item 목록을 뽑습니다. (응답 형식이 단순해 정규식으로 충분)
  // 인증 오류는 공공데이터포털 공통 형식(OpenAPI_ServiceResponse)으로 옵니다.
  function parseXml(xml) {
    const tag = name => { const m = String(xml).match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)); return m ? decode(m[1]).trim() : null; };
    const items = [...String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => {
      const o = {};
      for (const f of m[1].matchAll(/<(\w+)>([\s\S]*?)<\/\1>|<(\w+)\s*\/>/g)) {
        if (f[1]) o[f[1]] = decode(f[2]); else o[f[3]] = "";
      }
      return o;
    });
    return {
      resultCode: tag("resultCode"), resultMsg: tag("resultMsg"), totalCount: num(tag("totalCount")),
      items, authError: tag("returnAuthMsg") || (tag("errMsg") && tag("returnReasonCode") ? tag("errMsg") : null),
    };
  }

  // 분양권전매 한 달 요약: 해제여부(cdealType)가 표시된 거래는 뺍니다.
  function summarizeSilv(items) {
    const cancelled = items.filter(i => !blank(i.cdealType)).length;
    return { total: items.length, cancelled, count: items.length - cancelled };
  }

  // 전월세 한 달 요약
  //  - 기술문서에 해제 항목은 없지만, cdealType 값이 오면 해제로 보고 뺍니다.
  //  - 전세 = 월세금액(monthlyRent) 0, 월세 = 0보다 큼
  //  - 84㎡ 신규 전세(잔금 여력 표용): 84㎡ 중 월세 → 갱신 → 계약구분 미기재 순으로 빼고 남은 보증금
  function summarizeRent(items) {
    const s = { total: items.length, cancelled: 0, count: 0, jeonse: 0, wolse: 0, n84: 0, x84: { wolse: 0, renew: 0, unknown: 0 }, q84: [] };
    for (const i of items) {
      if (!blank(i.cdealType)) { s.cancelled++; continue; }
      s.count++;
      const jeonse = (num(i.monthlyRent) || 0) === 0;
      if (jeonse) s.jeonse++; else s.wolse++;
      if (!in84(num(i.excluUseAr))) continue;
      s.n84++;
      const type = String(i.contractType || "").trim();
      if (!jeonse) s.x84.wolse++;
      else if (type === "갱신") s.x84.renew++;
      else if (type !== "신규") s.x84.unknown++;
      else { const d = num(i.deposit); if (d !== null) s.q84.push(d); else s.x84.unknown++; }
    }
    return s;
  }

  // ── 인근 신규 공급 평당가 (청약홈 분양정보) ──
  const M2_PER_PYEONG = 400 / 121; // 1평 = 3.3058㎡
  const SUPPLY_MONTHS = 24;        // 모집공고일 기준 최근 24개월

  // 공고 1건 + 주택형 목록 → 차트 점 1개 (단지 1개)
  //  점 = 84㎡ 주택형들의 (분양최고금액 ÷ 공급평) 평균, 만원/평
  //  주택형(HOUSE_TY)은 전용면적("084.9800A")이라 84㎡ 판정에 쓰고, 평당가는 공급면적(SUPLY_AR) 기준
  //  임대 공고 · 84㎡ 주택형이 없는 단지는 빼고 이유를 돌려줍니다.
  function supplyPoint(notice, models) {
    if (String(notice.RENT_SECD || "0") !== "0") return { excluded: "rent" };
    const per = (models || [])
      .filter(m => in84(num(String(m.HOUSE_TY || "").replace(/[^\d.]/g, ""))))
      .map(m => ({ amount: num(m.LTTOT_TOP_AMOUNT), ar: num(m.SUPLY_AR) }))
      .filter(m => m.amount > 0 && m.ar > 0)
      .map(m => m.amount / (m.ar / M2_PER_PYEONG));
    if (!per.length) return { excluded: "no84" };
    const date = String(notice.RCRIT_PBLANC_DE || "");
    return {
      point: {
        label: notice.HOUSE_NM || "", date, ym: date.slice(0, 7),
        price: per.reduce((a, b) => a + b, 0) / per.length, types: per.length,
        address: notice.HSSPLY_ADRES || "", no: notice.HOUSE_MANAGE_NO || "",
      },
    };
  }

  const ymLabel = ym => `${ym.slice(0, 4)}.${ym.slice(4)}`;

  // 화면 상태(달별 결과)를 2장 표 두 개로 묶습니다.
  // state = { name, code, months:[YYYYMM], silv:{ym:{status,summary,fetchedAt,message}}, rent:{...} }
  // units · price: 우리 사업 주택형과 평당가(만원) → 84㎡ 세대당 분양가 = 공급평 × 평당가
  function buildMarket(state, units = [], price = null) {
    const months = state.months || [];
    const cell = (kind, ym) => (state[kind] && state[kind][ym]) || { status: "loading" };
    const done = kind => months.filter(ym => ["ok", "error"].includes(cell(kind, ym).status)).length;
    const okMonths = kind => months.filter(ym => cell(kind, ym).status === "ok");
    const sum = (kind, f) => okMonths(kind).reduce((a, ym) => a + f(cell(kind, ym).summary), 0);
    const dates = [...new Set(["silv", "rent"].flatMap(k => okMonths(k).map(ym => String(cell(k, ym).fetchedAt || "").slice(0, 10))).filter(Boolean))].sort();

    const table1 = {
      rows: months.map(ym => ({ ym, label: ymLabel(ym), silv: cell("silv", ym), rent: cell("rent", ym) })),
      totals: {
        silv: sum("silv", s => s.count), silvCancelled: sum("silv", s => s.cancelled),
        rent: sum("rent", s => s.count), rentCancelled: sum("rent", s => s.cancelled),
        jeonse: sum("rent", s => s.jeonse), wolse: sum("rent", s => s.wolse),
      },
      progress: { silv: done("silv"), rent: done("rent"), total: months.length },
      okMonths: { silv: okMonths("silv").length, rent: okMonths("rent").length },
      errors: ["silv", "rent"].flatMap(k => months.filter(ym => cell(k, ym).status === "error").map(ym => ({ kind: k, ym }))),
    };

    const deposits = okMonths("rent").flatMap(ym => cell("rent", ym).summary.q84);
    const avg = deposits.length ? deposits.reduce((a, b) => a + b, 0) / deposits.length : null;
    const ours = (price === null ? [] : units)
      .filter(u => in84(num(u.excl)) && num(u.supply) !== null)
      .map(u => {
        const unitPrice = num(u.supply) * price; // 만원
        return { name: u.name || "", excl: num(u.excl), supply: num(u.supply), unitPrice, ratio: avg !== null && unitPrice > 0 ? avg / unitPrice : null };
      });
    const table2 = {
      avg, n: deposits.length,
      monthsUsed: okMonths("rent").length,
      rentCount: sum("rent", s => s.count),
      n84: sum("rent", s => s.n84),
      excluded: {
        wolse: sum("rent", s => s.x84.wolse), renew: sum("rent", s => s.x84.renew),
        unknown: sum("rent", s => s.x84.unknown), non84: sum("rent", s => s.count - s.n84),
      },
      ours,
    };
    return { table1, table2, dates };
  }

  const Market = { MONTHS, BAND84, KIND_LABEL, M2_PER_PYEONG, SUPPLY_MONTHS, in84, num, recentMonths, parseXml, summarizeSilv, summarizeRent, supplyPoint, buildMarket, ymLabel };
  if (typeof module !== "undefined" && module.exports) module.exports = Market;
  else root.Market = Market;
})(this);
