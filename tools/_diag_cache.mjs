// 一次性验证：拖入文件 → 自动缓存 → 「最近」一键重开（自包含 CDP）
// 核心场景：用户拖进来的书（拿不到文件句柄）现在靠 IndexedDB 文件缓存
// 实现免重选重开。用一张 PNG 走完整链路：
//   1) 拖入图片成功开书，且文件缓存写入 IndexedDB
//   2) 历史列表显示「可一键重开」
//   3) 点历史记录 → 凭缓存重新导入，全程不出现「请重新选择文件」
//   4) forgetBook 后缓存联动清除
import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PORT = 8863;
const PORT_CDP = 9583;

const MIME = { ".html": "text/html; charset=utf-8", ".json": "application/json", ".png": "image/png" };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    let p = path.join(ROOT, decodeURIComponent(url.pathname));
    if (p.endsWith("/") || p.endsWith("\\")) p = path.join(p, "index.html");
    const data = await readFile(p);
    res.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream" });
    res.end(data);
  } catch { res.writeHead(404); res.end("404"); }
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const CHROME = [
  "C:\\Users\\DELL\\.agent-browser\\browsers\\chrome-153.0.8010.47\\chrome.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((c) => existsSync(c));
if (!CHROME) { console.log("未找到浏览器"); server.close(); process.exit(2); }

const profile = path.join(ROOT, ".cdp-profile-cache");
const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
  "--disable-extensions",
  `--remote-debugging-port=${PORT_CDP}`,
  `--user-data-dir=${profile}`,
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(2500);

async function getWs() {
  for (let i = 0; i < 24; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT_CDP}/json/list`);
      const list = await r.json();
      const t = list.find((x) => x.type === "page");
      if (t && t.webSocketDebuggerUrl) return t.webSocketDebuggerUrl;
    } catch {}
    await sleep(500);
  }
  return null;
}
const wsUrl = await getWs();
if (!wsUrl) { console.log("无法连接 CDP"); chrome.kill(); server.close(); process.exit(2); }

const ws = new WebSocket(wsUrl);
await new Promise((r) => (ws.onopen = r));
let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve) => { pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
}
async function evalJs(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "eval 出错");
  return r.result?.result?.value;
}
await send("Page.enable");
await send("Runtime.enable");

const out = [];
let fails = 0;
const check = (c, m) => { if (!c) fails++; out.push((c ? "  [通过] " : "  [失败] ") + m); };

// 页面内把一个 URL 包装成 File 并派发 drop（拖入导入的唯一入口）
async function dropUrlAsFile(url, filename) {
  await evalJs(`(function(){
    window.__dropDone = "pending";
    fetch(${JSON.stringify(url)}).then(r => r.blob()).then(blob => {
      var file = new File([blob], ${JSON.stringify(filename)}, { type: "image/png" });
      var dt = new DataTransfer();
      dt.items.add(file);
      window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles:true, cancelable:true }));
      window.__dropDone = "ok";
    }).catch(e => { window.__dropDone = "err: " + e.message; });
    return true;
  })()`);
  for (let i = 0; i < 20; i++) {
    if (await evalJs(`window.__dropDone`) !== "pending") break;
    await sleep(500);
  }
  return evalJs(`window.__dropDone`);
}

await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html` });
let opened = false;
for (let i = 0; i < 30; i++) {
  await sleep(1000);
  const s = await evalJs(`(window.gushiReader ? window.gushiReader.state().total : 0)`);
  if (s > 0) { opened = true; break; }
}
check(opened, "磁盘模式书籍已打开");

// 1) 拖入一张 PNG → 开书（1 页）
const drop = await dropUrlAsFile("/data/pages/00000.png", "测试拖入书.png");
check(drop === "ok", `拖入图片事件派发成功（实际 ${drop}）`);
let st = null;
for (let i = 0; i < 20; i++) {
  await sleep(1000);
  st = await evalJs(`JSON.stringify(window.gushiReader.state())`).then(JSON.parse);
  if (st.total === 1 && st.pendingPages === 0) break;
}
check(st && st.total === 1, `拖入后开书成功（total=${st ? st.total : "?"}）`);
const title1 = await evalJs(`window.gushiReader.state().title`);
check(title1 === "测试拖入书", `书名取自文件名（实际「${title1}」）`);
const docTitle = await evalJs(`document.title`);
check(docTitle.startsWith("右翻书古籍阅读器"), `标签页标题以「右翻书古籍阅读器」开头（实际「${docTitle}」）`);

// 2) 文件缓存已写入
const bookId = "file:测试拖入书:1";
st = await evalJs(`loadBookFiles(${JSON.stringify(bookId)}).then(v => JSON.stringify(v && v.files && v.files.length))`);
check(st === "1", `文件缓存已写入 IndexedDB（实际 ${st}）`);

// 3) 历史列表显示「可一键重开」
await evalJs(`buildHistoryList()`);
await sleep(400);
st = await evalJs(`(function(){
  var row = document.querySelector('.hp-item[data-hist-id="${bookId}"] .hp-sub');
  return row ? row.textContent : "";
})()`);
check(st.includes("可一键重开"), `列表提示「可一键重开」（实际「${st}」）`);

// 4) 点历史记录 → 凭缓存重新导入，不出现「请重新选择文件」
await evalJs(`(function(){
  window.__histRowClicked = true;
  document.getElementById("empty").classList.remove("show");
  buildHistoryList();
  return true;
})()`);
await evalJs(`document.querySelector('.hp-item[data-hist-id="${bookId}"]').click()`);
let reopened = false;
let showedRepick = false;
for (let i = 0; i < 20; i++) {
  await sleep(500);
  showedRepick = await evalJs(`(function(){
    var e = document.getElementById("empty");
    return e.classList.contains("show") && e.querySelector("h2").textContent === "请重新选择文件";
  })()`);
  if (showedRepick) break;
  st = await evalJs(`JSON.stringify(window.gushiReader.state())`).then(JSON.parse);
  if (st.total === 1 && !st.zoomed && st.pendingPages === 0){ reopened = true; break; }
}
check(!showedRepick, "全程没有出现「请重新选择文件」");
check(reopened, `凭缓存一键重开成功（total=${st.total}）`);
const title2 = await evalJs(`window.gushiReader.state().title`);
check(title2 === "测试拖入书", `重开后书名保持一致（实际「${title2}」）`);

// 5) forgetBook 联动清缓存
await evalJs(`forgetBook(${JSON.stringify(bookId)})`);
st = await evalJs(`loadBookFiles(${JSON.stringify(bookId)}).then(v => JSON.stringify(v))`);
check(st === "null", "forgetBook 后文件缓存已清除");
st = await evalJs(`readHistory().some(function(it){ return it.id === ${JSON.stringify(bookId)}; })`);
check(st === false, "forgetBook 后该条历史记录已移除");

console.log("\n右翻书古籍阅读器 · 拖入文件缓存与一键重开验证");
console.log("=".repeat(48));
out.forEach((l) => console.log(l));
console.log("-".repeat(48));
console.log(`全部通过（共 ${out.length} 项）` + (fails ? `，失败 ${fails} 项！` : ""));
chrome.kill();
server.close();
process.exit(fails ? 1 : 0);
