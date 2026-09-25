// 探针：点击「翻书」后视图状态的时间线，抓"弹回 scroll"的瞬间
import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PORT = 8868;
const PORT_CDP = 9588;

const MIME = { ".html": "text/html; charset=utf-8", ".json": "application/json", ".pdf": "application/pdf", ".js": "text/javascript; charset=utf-8" };
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
].find((c) => existsSync(c));
const profile = path.join(ROOT, ".cdp-profile-probe-view");
const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
  "--window-size=1400,900", `--remote-debugging-port=${PORT_CDP}`, `--user-data-dir=${profile}`, "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(2500);
let wsUrl = null;
for (let i = 0; i < 24 && !wsUrl; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT_CDP}/json/list`);
    const list = await r.json();
    const t = list.find((x) => x.type === "page");
    if (t) wsUrl = t.webSocketDebuggerUrl;
  } catch {}
  if (!wsUrl) await sleep(500);
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => (ws.onopen = r));
let msgId = 0;
const pendingMap = new Map();
const errs = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pendingMap.has(m.id)) { pendingMap.get(m.id)(m); pendingMap.delete(m.id); return; }
  if (m.method === "Runtime.exceptionThrown") errs.push(m.params.exceptionDetails?.exception?.description || "?");
};
function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve) => { pendingMap.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
}
async function evalJs(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "eval 出错");
  return r.result?.result?.value;
}

await send("Page.enable");
await send("Runtime.enable");
await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html` });
for (let i = 0; i < 24; i++) { await sleep(500); if (await evalJs(`!!window.gushiReader`).catch(() => false)) break; }
await evalJs(`try{ localStorage.clear(); }catch(e){} true`);

// 包一层 setViewMode / toggleViewMode，记录调用栈
await evalJs(`(function(){
  window.__calls = [];
  var orig = window.setViewMode;
  window.setViewMode = function(m){ window.__calls.push("setViewMode(" + m + ") @ " + new Error().stack.split("\\n")[2].trim()); return orig.apply(this, arguments); };
  return true;
})()`);

// 导入 PDF
const b64 = (await readFile(path.join(ROOT, "tools", "big-book-80.pdf"))).toString("base64");
await evalJs(`window.__pdfB64 = ${JSON.stringify(b64)}; true`);
await send("Runtime.evaluate", {
  expression: `(function(){
    var bin = atob(window.__pdfB64);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    var f = new File([arr], "big-book-80.pdf", { type: "application/pdf" });
    var dt = new DataTransfer(); dt.items.add(f);
    window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    return true;
  })()`, returnByValue: true, awaitPromise: true,
});
await sleep(3500);

// 点击翻书按钮，随后每 150ms 采样
const btn = await evalJs(`(function(){
  var b = document.getElementById("btnView");
  var r = b.getBoundingClientRect();
  b.click();
  return JSON.stringify({ rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width)], disabled: b.disabled });
})()`);
console.log("btn:", btn);
for (let i = 0; i < 8; i++) {
  const v = await evalJs(`document.body.dataset.view + " idx=" + (window.gushiReader ? window.gushiReader.state().idx : "?")`);
  console.log((i * 150) + "ms:", v);
  await sleep(150);
}
// 滑动条跳页，观察是否回弹
await evalJs(`(function(){
  var s = document.getElementById("slider");
  s.value = "59";
  s.dispatchEvent(new Event("input", { bubbles: true }));
  s.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
})()`);
console.log("--- slider 跳 59 后 ---");
for (let i = 0; i < 12; i++) {
  const v = await evalJs(`document.body.dataset.view + " idx=" + window.gushiReader.state().idx + " ready=" + (window.gushiReader.state().total > 0)`);
  console.log((i * 150) + "ms:", v);
  await sleep(150);
}
console.log("调用栈记录:", await evalJs(`JSON.stringify(window.__calls || [])`));
console.log("异常:", errs.length ? errs.slice(0, 5) : "无");
chrome.kill();
server.close();
process.exit(0);
