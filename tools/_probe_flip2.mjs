// 探针：复刻 book_blank 场景 A 的确切条件（1400x900、渲染中点击），
// 点击后每 100ms 采样 dataset.view，抓回弹时刻，并打印 diag 的 heals/errors
import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PORT = 8871;
const PORT_CDP = 9591;

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
const profile = path.join(ROOT, "tools/.cdp-profile-flip2");
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
const pre = await evalJs(`JSON.stringify({view: document.body.dataset.view, pend: window.gushiReader.state().pendingPages})`);
console.log("点击前:", pre);

await evalJs(`document.getElementById("btnView").click(); true`);
await sleep(800);
console.log("800ms 后 pend:", await evalJs(`window.gushiReader.state().pendingPages`));
await evalJs(`(function(){
  var s = document.getElementById("slider");
  s.value = "59";
  s.dispatchEvent(new Event("input", { bubbles: true }));
  s.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
})()`);
let lastV = null;
for (let i = 0; i < 60; i++) {
  const v = await evalJs(`document.body.dataset.view`);
  if (v !== lastV) { console.log("跳页后 " + (i * 100) + "ms:", v); lastV = v; }
  await sleep(100);
}
const d = JSON.parse(await evalJs(`JSON.stringify(window.gushiReader.diag())`));
console.log("diag:", JSON.stringify({ datasetView: d.datasetView, bookDisplay: d.bookDisplay, area: [d.areaW, d.areaH], errors: d.errors, heals: d.heals, bookNum: (await evalJs(`document.getElementById("bookNum").textContent`)) }));
console.log("异常:", errs.length ? errs.slice(0, 3) : "无");
chrome.kill();
server.close();
process.exit(0);
