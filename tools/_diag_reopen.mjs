// 一次性验证：最近打开 · 凭文件句柄一键重开（自包含 CDP）
// 说明：无头环境造不出真正的 FileSystemFileHandle（带方法的对象无法
// 进 IndexedDB），所以无缝重开主链路无法端到端模拟；这里验证
// 1) 句柄存取的读写删 2) 历史列表按句柄有无切换文案 3) 句柄失效时
// 的"找不到原来的文件"兜底 4) 无句柄时的"请重新选择文件"兜底
// 5) 删除记录联动清理句柄。
import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PORT = 8862;
const PORT_CDP = 9582;

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

const profile = path.join(ROOT, ".cdp-profile-reopen");
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

await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html` });
let opened = false;
for (let i = 0; i < 30; i++) {
  await sleep(1000);
  const s = await evalJs(`(window.gushiReader ? window.gushiReader.state().total : 0)`);
  if (s > 0) { opened = true; break; }
}
check(opened, "磁盘模式书籍已打开");

// 预置一条「本机文件」类历史记录
await evalJs(`(function(){
  localStorage.setItem("gushi-reader-history", JSON.stringify([{
    id: "file:test:1", name: "测试古籍", kind: "file",
    total: 6, page: 3, dir: "right-to-left", theme: "paper", at: Date.now()
  }]));
  return true;
})()`);

// 1) 句柄存取读写删
await evalJs(`saveBookHandles("file:test:1", [{ name: "t.pdf", handle: { name: "t.pdf" } }])`);
let v = await evalJs(`loadBookHandles("file:test:1").then(JSON.stringify)`);
check(!!v && v.includes("t.pdf"), "句柄保存后能读回");
await evalJs(`deleteBookHandles("file:test:1")`);
v = await evalJs(`loadBookHandles("file:test:1").then(JSON.stringify)`);
check(v === "null", "句柄删除后读回为 null");

// 2) 历史列表：有句柄 → 「可一键重开」
await evalJs(`saveBookHandles("file:test:1", [{ name: "t.pdf", handle: { name: "t.pdf" } }])`);
await evalJs(`buildHistoryList()`);
await sleep(400);   // 列表文案是异步回填的
v = await evalJs(`(function(){
  var row = document.querySelector('.hp-item[data-hist-id="file:test:1"] .hp-sub');
  return row ? row.textContent : "";
})()`);
check(v.includes("可一键重开"), `有句柄时提示「可一键重开」（实际「${v}」）`);

// 3) 句柄失效（造不出真句柄，用缺 getFile 的假句柄触发失效分支）
await evalJs(`document.querySelector('.hp-item[data-hist-id="file:test:1"]').click()`);
await sleep(500);
v = await evalJs(`(function(){
  var empty = document.getElementById("empty");
  var box = empty.querySelector(".box");
  return empty.classList.contains("show") ? box.querySelector("h2").textContent : "";
})()`);
check(v === "找不到原来的文件", `句柄失效时提示「找不到原来的文件」（实际「${v}」）`);
v = await evalJs(`(function(){
  var box = document.querySelector("#empty .box");
  return box.querySelector("p").textContent;
})()`);
check(v.includes("移动") || v.includes("改名") || v.includes("删除"), "失效提示说明文件可能被移动/改名/删除");

// 4) 无句柄且无缓存 → 「请重新选择文件」兜底
await evalJs(`deleteBookHandles("file:test:1")`);
await evalJs(`(function(){
  document.getElementById("empty").classList.remove("show");
  buildHistoryList();
  return true;
})()`);
await evalJs(`document.querySelector('.hp-item[data-hist-id="file:test:1"]').click()`);
await sleep(500);
v = await evalJs(`(function(){
  var empty = document.getElementById("empty");
  var box = empty.querySelector(".box");
  return empty.classList.contains("show") ? box.querySelector("h2").textContent : "";
})()`);
check(v === "请重新选择文件", `无句柄时提示「请重新选择文件」（实际「${v}」）`);
v = await evalJs(`document.querySelector("#empty .box p").textContent`);
check(v.includes("文件缓存"), "兜底文案说明了本地缓存不可用");

// 5) 列表文案：无句柄 → 「需重新选择文件」
await evalJs(`buildHistoryList()`);
await sleep(400);
v = await evalJs(`document.querySelector('.hp-item[data-hist-id="file:test:1"] .hp-sub').textContent`);
check(v.includes("需重新选择文件"), `无句柄时列表提示「需重新选择文件」（实际「${v}」）`);

// 6) 删除记录联动清理句柄（历史里还有磁盘演示书属正常，按 id 断言）
await evalJs(`saveBookHandles("file:test:1", [{ name: "t.pdf", handle: { name: "t.pdf" } }])`);
await evalJs(`forgetBook("file:test:1")`);
v = await evalJs(`loadBookHandles("file:test:1").then(JSON.stringify)`);
check(v === "null", "forgetBook 联动删除了句柄");
v = await evalJs(`readHistory().some(function(it){ return it.id === "file:test:1"; })`);
check(v === false, "forgetBook 移除了该条历史记录");

// 7) 无法结构化克隆的对象（模拟非法句柄）静默失败，不影响主流程
await evalJs(`saveBookHandles("bad", [{ name: "x", handle: { fn: function(){} } }])`);
v = await evalJs(`loadBookHandles("bad").then(JSON.stringify)`);
check(v === "null", "非法句柄静默保存失败（不抛错、不落库）");

console.log("\n右翻书古籍阅读器 · 最近打开一键重开验证");
console.log("=".repeat(44));
out.forEach((l) => console.log(l));
console.log("-".repeat(44));
console.log(`全部通过（共 ${out.length} 项）` + (fails ? `，失败 ${fails} 项！` : ""));
chrome.kill();
server.close();
process.exit(fails ? 1 : 0);
