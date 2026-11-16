// 배포용 빌드: 스크립트를 모두 넣은 단일 파일 dist/index.html 을 만듭니다.
// (외부 도구 없이 Node 내장 모듈만 사용 · 실행: npm run build)
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = __dirname;
const DIST = path.join(ROOT, "dist");

// 1) 계산·장 구성 모듈이 Node에서 정상적으로 불러와지는지 확인합니다.
require("./calc");
require("./presets");
require("./report");

// 2) index.html 의 <script src="..."> 를 파일 내용으로 바꿔 넣습니다.
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const inlined = [];
const out = html.replace(/<script src="([^"]+)"><\/script>/g, (_, src) => {
  const file = path.join(ROOT, src);
  if (!fs.existsSync(file)) throw new Error(`스크립트 파일 없음: ${src}`);
  const code = fs.readFileSync(file, "utf8");
  new vm.Script(code, { filename: src }); // 문법 오류 확인
  inlined.push(src);
  return `<script>/* ${src} */\n${code.replace(/<\/script/gi, "<\\/script")}\n</script>`;
});
if (/<script src=/.test(out)) throw new Error("넣지 못한 외부 스크립트가 남아 있습니다");

// 3) dist/index.html 로 저장합니다.
fs.mkdirSync(DIST, { recursive: true });
fs.writeFileSync(path.join(DIST, "index.html"), out);
console.log(`빌드 완료: dist/index.html (${(Buffer.byteLength(out) / 1024).toFixed(1)} KB) · 포함: ${inlined.join(", ")}`);
