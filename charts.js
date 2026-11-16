// SVG 차트 (라이브러리 없음) — 이미 계산된 값을 받아 그리기만 합니다.
// 축 눈금·좌표 변환 같은 "배치" 계산만 하고, 사업 숫자(합계·차이·비율)는 다시 계산하지 않습니다.
// 데이터가 없으면 null을 돌려주고, 화면은 빈 축 대신 "자료 없음"을 보여줍니다.
(function (root) {
  "use strict";

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // 천단위 콤마, 음수는 "−"
  function f(n, d = 0) {
    const s = Math.abs(n).toLocaleString("ko-KR", { minimumFractionDigits: d, maximumFractionDigits: d });
    return (n < 0 && /[1-9]/.test(s) ? "−" : "") + s;
  }
  const isNum = v => typeof v === "number" && isFinite(v);

  // 보기 좋은 눈금 간격 (1·2·5 × 10^k)
  function niceTicks(min, max, count = 5) {
    if (min === max) { min -= 1; max += 1; }
    const raw = (max - min) / count;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 5, 10].map(m => m * pow).find(s => s >= raw);
    const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(10));
    return { lo, hi, ticks };
  }

  const svgOpen = (w, h, label) =>
    `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">`;

  // ① 시장 대비 여유
  //  data = { points: [{ label, ym, price }], plan, repay }  (모두 만원/평, 이미 계산된 값)
  //  점: 인근 신규 공급 평당가 · 실선: 계획 평당가 · 점선: 상환 한계 평당가
  function marketMargin(data) {
    const pts = (data && data.points || []).filter(p => isNum(p.price));
    if (!pts.length || !isNum(data.plan)) return null;
    const W = 640, H = 300, L = 64, R = 120, T = 20, B = 40;
    const values = pts.map(p => p.price).concat(data.plan, isNum(data.repay) ? data.repay : []);
    const { lo, hi, ticks } = niceTicks(Math.min(...values), Math.max(...values));
    const y = v => T + (hi - v) / (hi - lo) * (H - T - B);
    const order = [...pts].sort((a, b) => String(a.ym).localeCompare(String(b.ym)));
    const xs = order.map((_, i) => L + (order.length === 1 ? 0.5 : i / (order.length - 1)) * (W - L - R));
    let s = svgOpen(W, H, "시장 대비 여유: 인근 신규 공급 평당가와 계획가 · 상환 한계");
    // 눈금
    for (const t of ticks) s += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text class="tick" x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${f(t)}</text>`;
    // 상환 한계 ~ 계획가 사이 = 여유 구간
    if (isNum(data.repay)) {
      const a = y(Math.max(data.plan, data.repay)), b = y(Math.min(data.plan, data.repay));
      s += `<rect class="${data.repay <= data.plan ? "band-ok" : "band-ng"}" x="${L}" y="${a}" width="${W - L - R}" height="${b - a}"/>`;
      s += `<line class="line-repay" x1="${L}" x2="${W - R}" y1="${y(data.repay)}" y2="${y(data.repay)}"/>`;
      s += `<text class="lbl-repay" x="${W - R + 6}" y="${y(data.repay) + 4}">상환 한계 ${f(data.repay)}</text>`;
    }
    s += `<line class="line-plan" x1="${L}" x2="${W - R}" y1="${y(data.plan)}" y2="${y(data.plan)}"/>`;
    s += `<text class="lbl-plan" x="${W - R + 6}" y="${y(data.plan) + 4}">계획가 ${f(data.plan)}</text>`;
    // 점
    order.forEach((p, i) => {
      s += `<circle class="pt" cx="${xs[i]}" cy="${y(p.price)}" r="5"><title>${esc(p.label || "")} ${esc(p.ym || "")} · ${f(p.price)}만원/평</title></circle>`;
    });
    // x축: 처음 · 끝 시기
    s += `<line class="axis" x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}"/>`;
    if (order.length) {
      s += `<text class="tick" x="${xs[0]}" y="${H - B + 18}" text-anchor="middle">${esc(order[0].ym || "")}</text>`;
      if (order.length > 1) s += `<text class="tick" x="${xs.at(-1)}" y="${H - B + 18}" text-anchor="middle">${esc(order.at(-1).ym || "")}</text>`;
    }
    s += `<text class="unit" x="${L - 8}" y="${T - 6}" text-anchor="end">만원/평</text>`;
    return s + "</svg>";
  }

  // ② 사업수지 폭포
  //  steps = Calc.waterfallSteps() 결과 [{ label, note, kind: total|down|up, value, from, to }] (억원)
  function waterfall(steps) {
    if (!steps || !steps.length || !steps.every(st => isNum(st.from) && isNum(st.to) && isNum(st.value))) return null;
    const W = 640, H = 320, L = 64, R = 16, T = 28, B = 52;
    const all = steps.flatMap(st => [st.from, st.to]).concat(0);
    const { lo, hi, ticks } = niceTicks(Math.min(...all), Math.max(...all));
    const y = v => T + (hi - v) / (hi - lo) * (H - T - B);
    const band = (W - L - R) / steps.length, bw = band * 0.56;
    let s = svgOpen(W, H, "사업수지 폭포: 분양수입에서 기말현금까지");
    for (const t of ticks) s += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text class="tick" x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${f(t)}</text>`;
    s += `<line class="zero" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"/>`;
    steps.forEach((st, i) => {
      const x = L + i * band + (band - bw) / 2;
      const top = y(Math.max(st.from, st.to)), bot = y(Math.min(st.from, st.to));
      const cls = st.kind === "total" ? (st.to < 0 ? "bar-neg" : "bar-total") : st.kind === "down" ? "bar-down" : "bar-up";
      s += `<rect class="${cls}" x="${x}" y="${top}" width="${bw}" height="${Math.max(bot - top, 1)}"><title>${esc(st.label)} ${f(st.value, 1)}억원</title></rect>`;
      // 값 표시 (변동 단계는 부호 포함)
      const txt = (st.kind === "up" ? "+" : "") + f(st.value, 1);
      const above = st.value >= 0 || st.kind !== "total";
      const ty = above ? top - 6 : bot + 14;
      s += `<text class="val ${st.value < 0 ? "neg" : ""}" x="${x + bw / 2}" y="${ty}" text-anchor="middle">${txt}</text>`;
      // 다음 막대로 잇는 선
      if (i < steps.length - 1 && steps[i + 1].kind !== "total") {
        s += `<line class="link" x1="${x + bw}" x2="${x + band}" y1="${y(st.to)}" y2="${y(st.to)}"/>`;
      }
      s += `<text class="cat" x="${x + bw / 2}" y="${H - B + 18}" text-anchor="middle">${esc(st.label)}</text>`;
      if (st.note) s += `<text class="note" x="${x + bw / 2}" y="${H - B + 33}" text-anchor="middle">${esc(st.note)}</text>`;
    });
    s += `<text class="unit" x="${L - 8}" y="${T - 10}" text-anchor="end">억원</text>`;
    return s + "</svg>";
  }

  const Charts = { niceTicks, marketMargin, waterfall };
  if (typeof module !== "undefined" && module.exports) module.exports = Charts;
  else root.Charts = Charts;
})(this);
