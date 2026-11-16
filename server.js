// 로컬 서버: node server.js → http://localhost:5173
//  - 화면 파일(정적) 제공
//  - GET /api/region?name=사업대상지 → 시군구 법정동코드 확인 (공공데이터 인증키는 서버에서만 사용)
const http = require("http");
const fs = require("fs");
const path = require("path");
const { lookupRegion } = require("./region");
const { streamTrades, retryMonth } = require("./trades");
const { getSupply } = require("./supply");

const PORT = process.env.PORT || 5173;
const ROOT = __dirname;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".json": "application/json" };
// 서버 전용 파일은 브라우저로 내려주지 않음
const SERVER_ONLY = new Set(["server.js", "region.js", "trades.js", "supply.js", "build.js", "package.json"]);

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  // 지역 확인 API: 응답에는 결과(이름·코드·후보)만 담고 인증키는 절대 넣지 않음
  if (url.pathname === "/api/region") {
    const result = await lookupRegion(url.searchParams.get("name") || "");
    return sendJson(res, 200, result);
  }

  // 실거래 최근 12개월: 브라우저는 지역 이름만 보내고, 코드는 서버가 다시 확인
  // 응답은 한 줄에 하나씩 JSON(NDJSON) — 끝난 달부터 바로 화면에 보이도록
  if (url.pathname === "/api/trades") {
    res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" });
    let closed = false;
    res.on("close", () => { closed = true; });
    await streamTrades(url.searchParams.get("name") || "", obj => { if (!closed) res.write(JSON.stringify(obj) + "\n"); }, { isClosed: () => closed });
    return res.end();
  }

  // 인근 신규 공급 평당가 (청약홈 분양정보) — 이름만 받고 코드는 서버가 다시 확인
  if (url.pathname === "/api/supply") {
    return sendJson(res, 200, await getSupply(url.searchParams.get("name") || ""));
  }

  // 실패한 달 [다시 시도]
  if (url.pathname === "/api/trades/month") {
    const q = url.searchParams;
    return sendJson(res, 200, await retryMonth(q.get("name") || "", q.get("kind") || "", q.get("ym") || ""));
  }

  const urlPath = decodeURIComponent(url.pathname);
  const file = path.join(ROOT, urlPath === "/" ? "index.html" : urlPath);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  const rel = path.relative(ROOT, file);
  // .env.local 같은 숨김 파일(비밀 키)과 서버 전용 파일은 내려주지 않음
  if (rel.split(path.sep).some(p => p.startsWith(".")) || SERVER_ONLY.has(rel)) { res.writeHead(404); return res.end("Not found"); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
