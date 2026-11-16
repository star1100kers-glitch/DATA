// 화면 스크립트: 입력 폼 처리 + 사업계획서 7개 장 그리기
// 계산은 calc.js, 장 구성(무엇을 보여줄지)은 report.js가 담당합니다.
(function () {
  "use strict";
  const { PRESETS } = Presets;
  const SALES_RATE = 1; // 화면은 분양률 100% 기준
  const NUM_FIELDS = { price: 0, retail: 0, other: 0, fixed: 1, pf: 0, pfCost: 0, sub: 0 }; // 소수 자리수
  const $ = id => document.getElementById(id);

  // ── 공통 도우미 ─────────────────────────────
  // 입력 문자열 → 숫자. 빈칸은 null (0으로 채우지 않음)
  const parse = s => {
    const t = String(s).replace(/,/g, "").trim();
    if (t === "") return null;
    const n = parseFloat(t);
    return isFinite(n) ? n : null;
  };
  const fmt = (n, d = 0) => n.toLocaleString("ko-KR", { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtInput = (el, d) => { const n = parse(el.value); if (n !== null) el.value = fmt(n, d); };
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // 숫자 표시: 천단위 콤마, 음수는 "−" + 빨강
  function N(n, d = 1, unit = "", sign = false) {
    if (n === null || n === undefined || !isFinite(n)) return '<span class="na">–</span>';
    const s = Report.f(n, d);
    const txt = (sign && n > 0 && /[1-9]/.test(s) ? "+" : "") + s + unit;
    return s.startsWith("−") ? `<span class="neg">${txt}</span>` : txt;
  }
  // 문장 속 음수("−123")를 빨강으로
  const redNeg = html => html.replace(/−[\d,.]+[^\s·()]*/g, m => `<span class="neg">${m}</span>`);
  const NA = '<span class="na">자료 없음</span>';
  const empty = (lackList, msg = "자료 없음") =>
    `<div class="empty"><b>${msg}</b>${lackList && lackList.length ? `<span>입력 필요: ${lackList.map(esc).join(" · ")}</span>` : ""}</div>`;
  const chapter = (no, title, body) =>
    `<section class="chapter" id="ch${no}"><h2><span class="no">${no}</span>${title}</h2>${body}</section>`;
  // 지표 한 줄: 이름 · 값 · 옆에 쓴 수식
  const metric = (label, value, formula, cls = "") =>
    `<div class="metric ${cls}"><span class="m-label">${label}</span><span class="m-value">${value}</span><span class="m-formula">${formula || ""}</span></div>`;

  // ── 입력 폼 ─────────────────────────────
  const tbody = $("units");

  function addRow(u = ["", "", "", ""]) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input data-k="name" placeholder="59형" aria-label="주택형 이름"></td>
      <td><input class="num" data-k="excl" data-d="1" inputmode="decimal" aria-label="전용㎡"></td>
      <td><input class="num" data-k="supply" data-d="1" inputmode="decimal" aria-label="공급평"></td>
      <td><input class="num" data-k="hh" data-d="0" inputmode="numeric" aria-label="세대수"></td>
      <td class="sub-total">–</td>
      <td><button type="button" class="ghost" title="행 삭제">✕</button></td>`;
    const ins = tr.querySelectorAll("input");
    ins[0].value = u[0];
    [1, 2, 3].forEach(i => { ins[i].value = u[i] === "" ? "" : fmt(+u[i], +ins[i].dataset.d); });
    tr.querySelector("button").onclick = () => { tr.remove(); update(); };
    tbody.appendChild(tr);
  }

  // 주택형 표 합계(공급면적 · 세대수) 갱신
  function updateTotals() {
    let hh = 0, area = 0;
    tbody.querySelectorAll("tr").forEach(tr => {
      const supply = parse(tr.querySelector('[data-k="supply"]').value) || 0;
      const n = parse(tr.querySelector('[data-k="hh"]').value) || 0;
      const a = supply * n;
      tr.querySelector(".sub-total").textContent = a ? fmt(a, 1) : "–";
      hh += n; area += a;
    });
    $("sumHH").textContent = fmt(hh) + " 세대";
    $("sumArea").textContent = fmt(area, 1) + " 평";
  }

  // 폼 값을 읽어옵니다. 빈칸은 null로 남깁니다.
  function readRaw() {
    const units = [...tbody.querySelectorAll("tr")].map(tr => ({
      name: tr.querySelector('[data-k="name"]').value.trim(),
      excl: parse(tr.querySelector('[data-k="excl"]').value),
      supply: parse(tr.querySelector('[data-k="supply"]').value),
      households: parse(tr.querySelector('[data-k="hh"]').value),
    }));
    const raw = { name: $("name").value.trim(), site: $("site").value.trim(), units };
    Object.keys(NUM_FIELDS).forEach(id => raw[id] = parse($(id).value));
    return raw;
  }

  function fill(p) {
    $("name").value = p ? p.name : "";
    $("site").value = p ? p.site : "";
    Object.entries(NUM_FIELDS).forEach(([id, d]) => $(id).value = p ? fmt(p[id], d) : "");
    tbody.innerHTML = "";
    if (p) p.units.forEach(u => addRow(u)); else addRow();
    scheduleRegion(0);
    update();
  }

  // ── 지역 확인 (서버 /api/region 호출 · 인증키는 서버에만 있음) ─────────────
  let region = { status: "empty" };
  let regionTimer = null, regionSeq = 0;

  // 사업대상지가 바뀌면 잠시 기다렸다가 서버에 법정동코드를 묻습니다.
  function scheduleRegion(delay = 500) {
    clearTimeout(regionTimer);
    const name = $("site").value.trim();
    if (!name) { region = { status: "empty" }; stopMarket(); renderReport(); return; }
    if (region.query === name && region.status !== "pending") return; // 이미 확인한 이름
    region = { status: "pending", query: name };
    regionTimer = setTimeout(() => checkRegion(name), delay);
  }

  async function checkRegion(name) {
    const seq = ++regionSeq;
    let result;
    if (location.protocol === "file:") {
      result = { status: "offline", query: name };
    } else {
      try {
        const res = await fetch(`/api/region?name=${encodeURIComponent(name)}`);
        result = res.ok ? await res.json() : { status: "offline", query: name };
      } catch { result = { status: "offline", query: name }; }
    }
    if (seq !== regionSeq) return; // 그 사이 이름이 또 바뀐 경우 무시
    region = { ...result, query: name };
    if (region.status === "ok") startMarket(region.name); else stopMarket();
    renderReport();
  }

  // ── 실거래 최근 12개월 (서버 /api/trades · 지역 이름만 보냄, 코드는 서버가 다시 확인) ──
  let market = null, marketCtl = null, renderQueued = false;

  // 여러 달이 연달아 도착해도 화면은 잠깐 모아서 한 번만 다시 그림
  // (requestAnimationFrame은 탭이 안 보이면 멈추므로 타이머 사용)
  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    setTimeout(() => { renderQueued = false; renderReport(); }, 60);
  }

  function stopMarket() {
    if (marketCtl) marketCtl.abort();
    marketCtl = null; market = null;
  }

  async function startMarket(name) {
    if (market && market.name === name) return; // 같은 지역은 다시 시작하지 않음
    stopMarket();
    const ctl = marketCtl = new AbortController();
    market = { name, code: null, months: [], silv: {}, rent: {}, done: false, failure: null, supply: { status: "loading" } };
    const m = market;
    loadSupply(m);
    try {
      const res = await fetch(`/api/trades?name=${encodeURIComponent(name)}`, { signal: ctl.signal });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (line) onMarketEvent(m, JSON.parse(line));
        }
      }
    } catch (e) {
      if (ctl.signal.aborted) return;
      m.failure = "실거래 조회 연결이 끊겼습니다";
    }
    // 스트림이 끝났는데 결과가 안 온 달은 실패로 표시해 [다시 시도] 할 수 있게
    for (const kind of ["silv", "rent"]) for (const ym of m.months) {
      if (!m[kind][ym] || m[kind][ym].status === "loading") m[kind][ym] = { status: "error", message: "응답 없음" };
    }
    m.done = true;
    if (market === m) queueRender();
  }

  // 인근 신규 공급 평당가 (서버 /api/supply · 이름만 보냄)
  async function loadSupply(m) {
    m.supply = { status: "loading" };
    let r;
    try { r = await (await fetch(`/api/supply?name=${encodeURIComponent(m.name)}`)).json(); }
    catch { r = { status: "error", message: "서버에 연결하지 못했습니다" }; }
    if (market !== m) return;
    m.supply = r;
    queueRender();
  }

  function onMarketEvent(m, ev) {
    if (ev.type === "region" && ev.status !== "ok") m.failure = `서버 지역 확인 실패 — ${Report.REGION_REASON[ev.status] || ev.status}${ev.message ? ` (${ev.message})` : ""}`;
    if (ev.type === "start") { m.code = ev.code; m.name = ev.name; m.months = ev.months; }
    if (ev.type === "month") m[ev.kind][ev.ym] = ev;
    if (ev.type === "done") m.done = true;
    if (market === m) queueRender();
  }

  // 실패한 달 [다시 시도]
  async function retryMonth(kind, ym) {
    const m = market;
    if (!m) return;
    m[kind][ym] = { status: "loading" };
    renderReport();
    let r;
    try {
      const res = await fetch(`/api/trades/month?name=${encodeURIComponent(m.name)}&kind=${kind}&ym=${ym}`);
      r = await res.json();
    } catch { r = { status: "error", message: "서버에 연결하지 못했습니다" }; }
    if (market !== m) return;
    m[kind][ym] = r;
    renderReport();
  }

  // 1장의 "법정동코드" 줄
  function regionMetric(r) {
    const label = "법정동코드 <small>시군구</small>";
    if (r.status === "ok") {
      return metric(label, `<b>${esc(r.code)}</b>`, `<span class="badge ok">확인됨</span> ${esc(r.name)} · 공공데이터 법정동코드 조회`);
    }
    if (r.status === "ambiguous" && r.candidates && r.candidates.length) {
      const list = r.candidates.map(c =>
        `<button type="button" class="cand" data-name="${esc(c.name)}">${esc(c.name)} <small>${esc(c.code)}</small></button>`).join("");
      return metric(label, NA, `<span class="badge ng">후보 ${r.candidates.length}개</span> 정확히 하나로 맞지 않습니다 — 선택하면 사업대상지가 바뀝니다<div class="cands no-print">${list}</div>`);
    }
    const reason = Report.REGION_REASON[r.status] || r.status;
    const extra = r.status === "error" && r.message ? ` (${esc(r.message)})` : "";
    const badge = r.status === "pending" ? "" : '<span class="badge ng">미확인</span> ';
    return metric(label, NA, `${badge}${esc(reason)}${extra}`);
  }

  // ── 사업계획서 7개 장 ─────────────────────────────
  function ch1(R) {
    const o = R.overview;
    if (o.empty) return chapter(1, "사업 개요", empty(R.missing.filter(m => ["사업명", "사업대상지", "주택형(공급평·세대수)"].includes(m))));
    const v = x => (x === null ? NA : x);
    const unitsTable = o.units.length
      ? `<div class="table-wrap"><table class="grid-table">
          <thead><tr><th>주택형</th><th class="r">전용㎡</th><th class="r">공급평</th><th class="r">세대수</th><th class="r">공급면적(평)</th></tr></thead>
          <tbody>${o.units.map(u => `<tr><td>${u.name ? esc(u.name) : NA}</td><td class="r">${N(u.excl, 1)}</td><td class="r">${N(u.supply, 1)}</td><td class="r">${N(u.households, 0)}</td><td class="r">${u.supply !== null && u.households !== null ? N(u.supply * u.households, 1) : "–"}</td></tr>`).join("")}</tbody>
          <tfoot><tr><td>합계</td><td></td><td></td><td class="r">${o.households !== null ? N(o.households, 0) : "–"}</td><td class="r">${o.supplyArea !== null ? N(o.supplyArea, 1) : "–"}</td></tr></tfoot>
        </table></div>`
      : empty(["주택형(공급평·세대수)"]);
    return chapter(1, "사업 개요", `
      <div class="metrics">
        ${metric("사업명", v(o.name ? esc(o.name) : null), "", "text")}
        ${metric("사업대상지", v(o.site ? esc(o.site) : null), "", "text")}
        ${regionMetric(o.region)}
        ${metric("세대수", o.households !== null ? N(o.households, 0, "세대") : NA, "Σ 주택형별 세대수")}
        ${metric("공급면적", o.supplyArea !== null ? N(o.supplyArea, 1, "평") : NA, "Σ 공급평 × 세대수")}
        ${metric("평당가", o.price !== null ? N(o.price, 0, "만원") : NA)}
        ${metric("상가", o.retail !== null ? N(o.retail, 1, "억원") : NA)}
      </div>
      <h3>주택형</h3>${unitsTable}`);
  }

  function ch2(R) {
    const M = R.market;
    if (!M.ok) {
      const why = market && market.failure ? market.failure
        : region.status === "ok" ? "" : `지역 미확인 — ${Report.REGION_REASON[region.status] || region.status}`;
      return chapter(2, "시장 분석", empty(why ? [why] : null, esc(M.message)).replace("입력 필요: ", "") + marketChartBlock(R));
    }
    const t1 = M.table1, t2 = M.table2, P = t1.progress;
    const dates = !M.dates.length ? "–" : M.dates.length === 1 ? M.dates[0] : `${M.dates[0]} ~ ${M.dates[M.dates.length - 1]}`;
    const area = `${esc(M.name)} (법정동코드 ${esc(M.code)})`;
    const meta = rows => `<dl class="meta">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>`;
    const progress = `<p class="progress ${P.silv + P.rent < P.total * 2 ? "busy" : ""}">분양권 ${P.silv}/${P.total} · 전월세 ${P.rent}/${P.total}${t1.errors.length ? ` · <span class="neg">실패 ${t1.errors.length}</span>` : ""}</p>`;

    // ① 월별 거래 건수
    const cnt = (kind, c, ym) => {
      if (c.status === "ok") return N(c.summary.count, 0);
      if (c.status === "error") return `<span class="neg" title="${esc(c.message || "")}">오류</span> <button type="button" class="retry no-print" data-kind="${kind}" data-ym="${ym}">다시 시도</button><div class="errmsg">${esc(c.message || "")}</div>`;
      return '<span class="na">조회 중…</span>';
    };
    const sub = (c, f) => (c.status === "ok" ? `<small>${f(c.summary)}</small>` : "");
    const table1 = `
      <div class="table-wrap"><table class="grid-table">
        <thead><tr><th>계약월</th><th class="r">분양권 전매</th><th class="r">전월세</th><th class="r">전세 · 월세</th></tr></thead>
        <tbody>${t1.rows.map(r => `<tr>
          <td>${r.label}</td>
          <td class="r">${cnt("silv", r.silv, r.ym)}</td>
          <td class="r">${cnt("rent", r.rent, r.ym)}</td>
          <td class="r">${sub(r.rent, s => `${fmt(s.jeonse)} · ${fmt(s.wolse)}`)}</td></tr>`).join("")}</tbody>
        <tfoot><tr><td>합계</td><td class="r">${N(t1.totals.silv, 0)}</td><td class="r">${N(t1.totals.rent, 0)}</td><td class="r"><small>${fmt(t1.totals.jeonse)} · ${fmt(t1.totals.wolse)}</small></td></tr></tfoot>
      </table></div>
      ${meta([
        ["지역", area],
        ["건수", `분양권 ${fmt(t1.totals.silv)}건 (${t1.okMonths.silv}/${P.total}개월) · 전월세 ${fmt(t1.totals.rent)}건 (${t1.okMonths.rent}/${P.total}개월)`],
        ["제외 기준", `분양권: 해제여부(cdealType) 표시 거래 ${fmt(t1.totals.silvCancelled)}건 제외 · 전월세: 기술문서에 해제 항목 없음${t1.totals.rentCancelled ? ` (해제 표시 ${fmt(t1.totals.rentCancelled)}건 제외)` : ""}`],
        ["조회일", dates],
      ])}`;

    // ② 잔금 여력
    const band = `전용 ${Market.BAND84.min}㎡ 이상 ${Market.BAND84.max}㎡ 미만`;
    let body2;
    if (!t2.ours.length) {
      body2 = empty([`우리 사업에 84㎡(${band}) 주택형 · 평당가 입력`]);
    } else if (t2.avg === null) {
      body2 = empty(null, t2.monthsUsed ? "84㎡ 신규 전세 거래 없음" : "자료 없음 — 전월세 조회 중");
    } else {
      body2 = `<div class="metrics">
        ${metric("84㎡ 신규 전세 평균", N(t2.avg, 0, "만원"), `= 보증금 합계 ÷ ${fmt(t2.n)}건`)}
        ${t2.ours.map(o => `
          ${metric(`우리 ${esc(o.name || "84㎡")} 세대당 분양가`, N(o.unitPrice, 0, "만원"), `= 공급 ${N(o.supply, 1)}평 × 평당가 ${N(R.overview.price, 0)}만원`)}
          ${metric("잔금 여력", N(o.ratio * 100, 1, "%"), `= 84㎡ 신규 전세 평균 ${N(t2.avg, 0)} ÷ 세대당 분양가 ${N(o.unitPrice, 0)}`, "key")}`).join("")}
      </div>`;
    }
    const x = t2.excluded;
    const table2 = `${body2}
      ${meta([
        ["지역", area],
        ["건수", `기준 충족 ${fmt(t2.n)}건 / 84㎡ 전월세 ${fmt(t2.n84)}건 / 전월세 전체 ${fmt(t2.rentCount)}건 (${t2.monthsUsed}/${P.total}개월)`],
        ["제외 기준", `84㎡ = ${band} · 월세(월세금액 > 0) ${fmt(x.wolse)}건 · 갱신 계약 ${fmt(x.renew)}건 · 계약구분 미기재 ${fmt(x.unknown)}건 · 84㎡ 외 면적 ${fmt(x.non84)}건 제외`],
        ["조회일", dates],
      ])}`;

    return chapter(2, "시장 분석", `
      ${progress}
      <h3>① 월별 거래 건수 <small>최근 12개월 · 계약월 기준</small></h3>${table1}
      <h3>② 잔금 여력 <small>84㎡ 신규 전세 평균 ÷ 우리 84㎡ 세대당 분양가</small></h3>${table2}
      ${marketChartBlock(R)}`);
  }

  // ── 차트 (charts.js가 SVG를 그림 · 숫자는 report/calc에서 이미 계산된 값) ──
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const caption = rows => `<dl class="meta chart-meta">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>`;

  // 차트 ① 시장 대비 여유 (2장)
  function marketChartBlock(R) {
    const c = R.marketChart;
    const svg = Charts.marketMargin(c);
    const lack = [];
    if (!c.points.length) {
      lack.push(c.status === "loading" ? "인근 신규 공급 평당가 — 조회 중…"
        : c.status === "error" ? `인근 신규 공급 평당가 — 조회 실패: ${c.message || ""}`
        : c.status === "ok" ? "인근 신규 공급 평당가 — 최근 24개월 84㎡ 공급 단지 없음"
        : "인근 신규 공급 평당가 — 지역 확인 후 조회");
    }
    if (c.plan === null) lack.push("계획 평당가");
    if (c.repay === null) lack.push("상환 한계 평당가 (5장 계산에 필요한 입력)");
    const x = c.excluded;
    const exText = x ? [x.no84 && `84㎡ 주택형 없음 ${fmt(x.no84)}`, x.rent && `임대 ${fmt(x.rent)}`, x.error && `주택형 조회 실패 ${fmt(x.error)}`].filter(Boolean).join(" · ") : "";
    const count = c.status === "ok"
      ? `${fmt(c.points.length)}개 단지 (APT 공고 ${fmt(c.notices)}건${exText ? ` 중 제외: ${exText}` : ""})${c.window ? ` · 모집공고일 ${esc(c.window.from)} ~ ${esc(c.window.to)}` : ""}`
      : "–";
    return `<h3>차트 · 시장 대비 여유 <small>인근 신규 공급 평당가 · 계획가 · 상환 한계</small></h3>
      ${svg ? `<figure class="chart-box">${svg}</figure>` : empty(lack).replace("입력 필요: ", "없는 자료: ")}
      ${c.points.length ? `<div class="table-wrap"><table class="grid-table pts">
        <thead><tr><th>단지</th><th>모집공고일</th><th class="r">84㎡ 타입</th><th class="r">평당가(만원)</th></tr></thead>
        <tbody>${c.points.map(p => `<tr><td>${esc(p.label)}</td><td>${esc(p.date)}</td><td class="r">${fmt(p.types)}</td><td class="r">${N(p.price, 0)}</td></tr>`).join("")}</tbody>
      </table></div>` : ""}
      ${caption([
        ["단위", "만원/평 · 공급면적 기준 · 점 = 단지별 84㎡ 주택형 분양최고금액 ÷ 공급평 (평균)"],
        ["건수", count],
        ["조회일", c.fetchedAt ? esc(String(c.fetchedAt).slice(0, 10)) : "–"],
        ["출처", `점: ${c.source ? esc(c.source) : "청약홈 분양정보 (조회 전)"} · 계획가: 입력값${c.plan !== null ? ` ${fmt(c.plan)}` : ""} · 상환 한계: 5장 계산${c.repay !== null ? ` ${fmt(Math.round(c.repay))}` : ""}`],
      ])}`;
  }

  // 차트 ② 사업수지 폭포 (3장)
  function waterfallBlock(R) {
    const F = R.feasibility;
    const svg = F.ok ? Charts.waterfall(F.waterfall) : null;
    return `<h3>차트 · 사업수지 폭포 <small>분양수입 → 변동비 → 고정비 → 기타유입 → 기말현금</small></h3>
      ${svg ? `<figure class="chart-box">${svg}</figure>` : empty(F.lack)}
      ${caption([
        ["단위", "억원"],
        ["건수", F.ok ? `${F.waterfall.length}단계 · ${fmt(F.result.households)}세대 · 분양률 ${Report.pct(R.rate, 0)}` : "–"],
        ["조회일", `${today()} (입력값으로 계산한 날)`],
        ["출처", "입력값 + 3장 사업수지 계산 · 변동비 = 학교용지 0.8% + 분양대행 세대당 300만원"],
      ])}`;
  }

  function ch3(R) {
    const F = R.feasibility;
    if (!F.ok) return chapter(3, "사업수지", empty(F.lack));
    const r = F.result, i = F.input, rate = Report.pct(R.rate, 0);
    return chapter(3, "사업수지", `
      <p class="basis">분양률 ${rate} 기준 · 단위 억원</p>
      <div class="metrics">
        ${metric("분양수입", N(r.revenue, 1), `= (공급면적 ${N(r.supplyArea, 1)}평 × 평당가 ${N(i.price, 0)}만원 ÷ 10,000 + 상가 ${N(i.retail, 1)}) × 분양률 ${rate}`)}
        ${metric("(−) 학교용지", N(r.schoolLevy, 1), `= 분양수입 × 0.8%`)}
        ${metric("(−) 분양대행", N(r.agencyFee, 1), `= 팔린 세대 ${N(r.soldHouseholds, 0)}세대 × 300만원`)}
        ${metric("(+) 기타유입", N(i.other, 1), "입력값")}
        ${metric("(−) 고정비", N(i.fixed, 1), "입력값")}
        ${metric("기말현금", N(r.endingCash, 1, "", true), "= 분양수입 × (1 − 0.8%) − 분양대행 + 기타유입 − 고정비", "total")}
      </div>
      ${waterfallBlock(R)}`);
  }

  function ch4(R) {
    const P = R.funding;
    if (!P.ok) return chapter(4, "자금조달과 상환", empty(P.lack));
    const r = P.result, i = P.input;
    return chapter(4, "자금조달과 상환", `
      <p class="basis">분양률 ${Report.pct(R.rate, 0)} 기준 · 단위 억원</p>
      <div class="metrics">
        ${metric("본PF", N(i.pf, 1), "입력값")}
        ${metric("본PF 금융비용", N(i.pfCost, 1), "입력값")}
        ${metric("후순위", N(i.sub, 1), "입력값")}
        ${metric("PF 상환 대상", N(P.debt, 1), `= 본PF ${N(i.pf, 1)} + 금융비용 ${N(i.pfCost, 1)}`)}
        ${metric("만기 누적 DSCR", N(r.dscr, 2, "배"), `= 1 + (기말현금 ${N(r.endingCash, 1)} + 후순위 ${N(i.sub, 1)}) ÷ (본PF ${N(i.pf, 1)} + 금융비용 ${N(i.pfCost, 1)})`, "key")}
        ${metric("LTV", N(r.ltv * 100, 1, "%"), `= 본PF ${N(i.pf, 1)} ÷ 분양률 100% 분양수입 ${N(Calc.salesRevenue(i, 1), 1)}`, "key")}
        ${metric("상환 여유", N(P.margin, 1, "", true), `= 기말현금 ${N(r.endingCash, 1)} + 후순위 ${N(i.sub, 1)}`)}
        ${metric("PF 전액 상환", P.canRepay ? '<span class="badge ok">가능</span>' : '<span class="badge ng">불가</span>', `기말현금 ${N(r.endingCash, 1)} ${P.canRepay ? "≥" : "<"} −후순위 ${N(-i.sub, 1)}`, "total")}
      </div>`);
  }

  function ch5(R) {
    const S = R.sensitivity;
    if (!S.ok) return chapter(5, "민감도", empty(S.lack));
    const L = S.limits, plan = S.input.price;
    const pctN = r => (isFinite(r) ? N(r * 100, 1, "%") : "–");
    const won = p => (isFinite(p) ? N(p, 0, "만원") : "–");
    const head = S.table.columns.map(c =>
      `<th class="${c.delta === 0 ? "plan" : ""}">${fmt(c.price)}<br><small>${c.delta === 0 ? "계획" : (c.delta > 0 ? "+" : "−") + fmt(Math.abs(c.delta))}</small></th>`).join("");
    const body = S.table.rows.map(row =>
      `<tr><th class="row">${Report.pct(row.rate, 0)}</th>` + row.cells.map((cell, k) => {
        const cls = [cell.canRepay ? "ok" : "ng", row.rate === 1 && S.table.columns[k].delta === 0 ? "plan" : ""].join(" ");
        return `<td class="${cls}" title="${cell.canRepay ? "상환 가능" : "상환 불가"}">${N(cell.endingCash, 1, "", true)}</td>`;
      }).join("") + "</tr>").join("");
    return chapter(5, "민감도", `
      <h3>두 한계선</h3>
      <div class="table-wrap"><table class="grid-table">
        <thead><tr><th></th><th class="r">분양률<br><small>계획 평당가 ${fmt(plan)}만원</small></th><th class="r">평당가<br><small>분양률 100%</small></th></tr></thead>
        <tbody>
          <tr><td>기말현금 0</td><td class="r b">${pctN(L.zero.rate)}</td><td class="r b">${won(L.zero.price)}</td></tr>
          <tr><td>상환 한계 <small>기말현금 = −후순위</small></td><td class="r b">${pctN(L.repay.rate)}</td><td class="r b">${won(L.repay.price)}</td></tr>
        </tbody>
      </table></div>
      <h3>기말현금 민감도 <small>단위 억원 · 초록 = 상환 가능(기말현금 ≥ −후순위) · 빨강 = 불가</small></h3>
      <div class="table-wrap"><table class="sens">
        <thead><tr><th class="row">분양률↓ 평당가→</th>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table></div>
      <p class="verdict">${S.sentence ? esc(S.sentence) : "상환 한계를 구할 수 없습니다"}</p>
      <p class="note">평당가 한계는 분양률 100% 기준, 분양률 한계는 계획 평당가 기준 · 문장의 한계값은 "이상이면"이 성립하도록 올림</p>`);
  }

  function ch6(R) {
    const K = R.risks;
    if (!K.ok) return chapter(6, "리스크와 완화 방안", empty(K.lack));
    return chapter(6, "리스크와 완화 방안", `
      <p class="basis">5장의 두 한계선(기말현금 0 · 상환 한계)에서 거꾸로 짚은 항목입니다.</p>
      ${K.items.map((k, n) => `
        <div class="risk ${k.ok ? "ok" : "ng"}">
          <h3>${n + 1}. ${esc(k.title)} <span class="badge ${k.ok ? "ok" : "ng"}">${k.ok ? "계획 기준 여유 있음" : "계획 기준 미달"}</span></h3>
          <p>${redNeg(esc(k.finding))}</p>
          <ul>${k.mitigation.map(m => `<li>${redNeg(esc(m))}</li>`).join("")}</ul>
        </div>`).join("")}`);
  }

  function ch7(R) {
    return chapter(7, "확인하지 못한 것", `<ul class="unverified">${R.unverified.map(t => `<li>${esc(t)}</li>`).join("")}</ul>`);
  }

  function renderReport() {
    const raw = readRaw();
    const R = Report.buildReport(raw, SALES_RATE, region, market);
    $("docTitle").textContent = R.overview.name ? `사업계획서 — ${R.overview.name}` : "사업계획서";
    $("docSub").textContent = [R.overview.site, `작성 ${new Date().toLocaleDateString("ko-KR")}`].filter(Boolean).join(" · ");
    $("report").innerHTML = [ch1, ch2, ch3, ch4, ch5, ch6, ch7].map(fn => fn(R)).join("");
  }

  function update() { updateTotals(); renderReport(); }

  // ── 이벤트 연결 ─────────────────────────────
  $("form").addEventListener("input", update);
  tbody.addEventListener("focusout", e => { if (e.target.dataset.d) fmtInput(e.target, +e.target.dataset.d); });
  Object.entries(NUM_FIELDS).forEach(([id, d]) => $(id).addEventListener("blur", e => fmtInput(e.target, d)));
  document.querySelectorAll("[data-preset]").forEach(b => b.onclick = () => fill(PRESETS[b.dataset.preset]));
  $("clear").onclick = () => fill(null);
  $("addRow").onclick = () => { addRow(); update(); };
  $("print").onclick = () => window.print();
  $("site").addEventListener("input", () => scheduleRegion());
  // 후보 버튼: 누르면 사업대상지를 그 이름으로 바꾸고 다시 확인
  $("report").addEventListener("click", e => {
    const rt = e.target.closest(".retry");
    if (rt) return retryMonth(rt.dataset.kind, rt.dataset.ym);
    const b = e.target.closest(".cand");
    if (!b) return;
    $("site").value = b.dataset.name;
    scheduleRegion(0);
    update();
  });

  fill(null);
})();
