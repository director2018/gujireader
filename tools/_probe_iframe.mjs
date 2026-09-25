// 探针：模拟 WorkBuddy 预览面板 —— index.html 嵌在 iframe 里跑，
// slate 主题 + 翻书视图 + 跳中间页，看渲染是否正常。
import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PORT = 8869;
const PORT_CDP = 9589;

const MIME = { ".html": "text/html; charset=utf-8", ".json": "application/json", ".pdf": "application/pdf", ".js": "text/javascript; charset=utf-8" };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/host") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><body style="margin:0">
<iframe id="f" src="http://127.0.0.1:${PORT}/index.html" style="width:100vw;height:100vh;border:0"></iframe>
</body></html>`);
      return;
    }
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
const profile = path.join(ROOT, ".cdp-profile-iframe");
const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
  "--window-size=1920,1040", `--remote-debugging-port=${PORT_CDP}`, `--user-data-dir=${profile}`, "about:blank",
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
async function evalIn(expr) {  // 在 iframe 里执行
  const r = await send("Runtime.evaluate", {
    expression: `(function(){ var f = document.getElementById("f"); var w = f.contentWindow; var d = f.contentDocument; return (function(){ ${expr} })(); })()`,
    returnByValue: true, awaitPromise: true,
  });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "eval 出错");
  return r.result?.result?.value;
}
async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  if (r.result?.data) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(HERE, name), Buffer.from(r.result.data, "base64"));
  }
}

await send("Page.enable");
await send("Runtime.enable");
await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/host` });
for (let i = 0; i < 24; i++) {
  await sleep(500);
  try { if (await evalIn(`return !!w.gushiReader;`)) break; } catch {}
}

// slate 主题 + 翻书视图预置，然后导入 PDF
await evalIn(`try{ w.localStorage.clear(); w.localStorage.setItem("gushi-reader-theme","slate"); w.localStorage.setItem("gushi-reader-view","book"); }catch(e){} return true;`);
// 主题即时生效需要重载
await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/host` });
await sleep(3000);
for (let i = 0; i < 10; i++) { try { if (await evalIn(`return !!w.gushiReader;`)) break; } catch {} await sleep(500); }
await evalIn(`try{ w.localStorage.setItem("gushi-reader-theme","slate"); w.localStorage.setItem("gushi-reader-view","book"); }catch(e){} return true;`);

const b64 = (await readFile(path.join(ROOT, "tools", "big-book-80.pdf"))).toString("base64");
await evalIn(`w.__pdfB64 = ${JSON.stringify(b64)}; return true;`);
await evalIn(`
  var bin = atob(w.__pdfB64);
  var arr = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  var f = new File([arr], "big-book-80.pdf", { type: "application/pdf" });
  var dt = new DataTransfer(); dt.items.add(f);
  w.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  return true;
`);
await sleep(4500);

const info = await evalIn(`return (function(){
  var s = w.gushiReader.state();
  var bookEl = d.getElementById("book");
  var area = d.getElementById("bookArea");
  var ar = area.getBoundingClientRect();
  var R = d.getElementById("bookR"); var rr = R.getBoundingClientRect();
  var im = R.querySelector("img");
  return JSON.stringify({
    view: d.body.dataset.view, theme: d.body.dataset.theme,
    bookDisplay: bookEl ? getComputedStyle(bookEl).display : "n/a",
    areaW: Math.round(ar.width), areaH: Math.round(ar.height),
    R: { display: R.style.display, w: Math.round(rr.width), h: Math.round(rr.height),
         src: im ? (im.getAttribute("src")||"").slice(0,40) : null, nw: im ? im.naturalWidth : -1 },
    total: s.total, idx: s.idx, pend: s.pendingPages,
  });
})()`);
console.log("导入后:", info);

// 跳到中间页
await evalIn(`var s0 = d.getElementById("slider"); s0.value = "59"; s0.dispatchEvent(new Event("input",{bubbles:true})); return true;`);
await sleep(4000);
const info2 = await evalIn(`return (function(){
  var s = w.gushiReader.state();
  var area = d.getElementById("bookArea").getBoundingClientRect();
  var R = d.getElementById("bookR"); var rr = R.getBoundingClientRect();
  var im = R.querySelector("img");
  return JSON.stringify({
    idx: s.idx, pend: s.pendingPages, view: d.body.dataset.view,
    areaW: Math.round(area.width), areaH: Math.round(area.height),
    R: { display: R.style.display, w: Math.round(rr.width), h: Math.round(rr.height), nw: im ? im.naturalWidth : -1 },
    bookNum: d.getElementById("bookNum").textContent,
  });
})()`);
console.log("跳 60 页后:", info2);
await shot("_diag_iframe_book.png");
console.log("异常:", errs.length ? errs.slice(0, 5) : "无");
chrome.kill();
server.close();
process.exit(0);
