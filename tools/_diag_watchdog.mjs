// 诊断：翻书视图看门狗（自愈）行为
//   1) 单次瞬态缺页（<1.2s 的干扰）不应弹提示、不应自愈 —— 不打扰；
//   2) 持续缺页（>= 2 轮体检，约 2.4s）应自愈重摆，且在 diag().heals 里留下证据细节；
//   3) 自愈后视图恢复正常出图。
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

const MIME = {
  ".html": "text/html; charset=utf-8", ".json": "application/json", ".png": "image/png",
  ".pdf": "application/pdf", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
};
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    let p = path.join(ROOT, decodeURIComponent(url.pathname));
    if (p.endsWith("/") || p.endsWith("\\")) p = path.join(p, "index.html");
    const data = await readFile(p);
    res.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream", "Cache-Control": "no-store" });
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

const profile = path.join(ROOT, ".cdp-profile-wd");
const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
  "--disable-extensions", "--window-size=1400,900",
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
const errs = [], dialogs = [];

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === "Runtime.exceptionThrown") {
    errs.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || "?");
  }
  if (m.method === "Page.javascriptDialogOpening") {
    dialogs.push(m.params.message);
    send("Page.handleJavaScriptDialog", { accept: true });
  }
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
const say = (s) => out.push(s);
let fails = 0;
const check = (c, m) => { if (!c) fails++; out.push((c ? "  [通过] " : "  [失败] ") + m); };

async function dropPdf(fileName) {
  const b64 = (await readFile(path.join(ROOT, "tools", fileName))).toString("base64");
  await evalJs(`(function(){ window.__pdfDone="pending"; window.__pdfB64 = ${JSON.stringify(b64)}; return true; })()`);
  await send("Runtime.evaluate", {
    expression: `(function(){
      try{
        var bin = atob(window.__pdfB64);
        var arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        var f = new File([arr], ${JSON.stringify(fileName)}, { type: "application/pdf" });
        var dt = new DataTransfer(); dt.items.add(f);
        window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
        window.__pdfDone = "ok";
      }catch(e){ window.__pdfDone = "err " + e.message; }
      return true;
    })()`, returnByValue: true, awaitPromise: true,
  });
  for (let i = 0; i < 60; i++) {
    const d = await evalJs(`window.__pdfDone`);
    if (d !== "pending") return d;
    await sleep(500);
  }
  return "timeout";
}

async function openUrl(url) {
  await send("Page.navigate", { url });
  for (let i = 0; i < 24; i++) {
    await sleep(500);
    const ok = await evalJs(`!!window.gushiReader`).catch(() => false);
    if (ok) break;
  }
  await evalJs(`try{ localStorage.clear(); }catch(e){} true`);
  await send("Page.navigate", { url });
  for (let i = 0; i < 24; i++) {
    await sleep(500);
    const ok = await evalJs(`!!window.gushiReader`).catch(() => false);
    if (ok) break;
  }
  await sleep(600);
}

const heals = async () => JSON.parse(await evalJs(`JSON.stringify(window.gushiReader.diag().heals)`));

console.log("\n右翻书古籍阅读器 · 看门狗（自愈）验证");
await openUrl(`http://127.0.0.1:${PORT}/index.html`);
say("drop: " + await dropPdf("big-book-80.pdf"));
await sleep(3500);
await evalJs(`document.getElementById("btnView").click(); true`);
await sleep(1500);
const st0 = JSON.parse(await evalJs(`JSON.stringify(window.gushiReader.state())`));
check(st0.view === "book" && st0.total > 0, `进入翻书视图（view=${st0.view}, 共 ${st0.total} 页）`);

const H0 = (await heals()).length;
say("基线 heals: " + H0);

/* ---- 场景 1：瞬态缺页 600ms —— 不应自愈、不应弹提示 ---- */
await evalJs(`document.getElementById("bookR").style.display = "none"; true`);
await sleep(600);
await evalJs(`document.getElementById("bookR").style.display = ""; true`);
await sleep(1600);   // 跨过下一次体检，确认 streak 已复位
const H1 = (await heals()).length;
check(H1 === H0, `瞬态缺页没有触发自愈（heals ${H0} -> ${H1}）`);

/* ---- 场景 2：持续缺页 —— 约 2.4s 内自愈，且留下证据 ---- */
await evalJs(`document.getElementById("bookR").style.display = "none"; true`);
await sleep(4200);
const H2 = (await heals()).length;
check(H2 > H1, `持续缺页触发了自愈（heals ${H1} -> ${H2}）`);
const lastHeal = (await heals()).pop() || "";
check(lastHeal.includes("翻书视图缺页") && lastHeal.includes("【"), `自愈记录带证据细节（${lastHeal.slice(0, 60)}…）`);
const snap = JSON.parse(await evalJs(`(function(){
  var el = document.getElementById("bookR");
  var im = el.querySelector("img");
  return JSON.stringify({ display: el.style.display, src: im ? (im.getAttribute("src")||"").length : 0 });
})()`));
check(snap.display !== "none" && snap.src > 0, `自愈后槽位已重摆出图（display=${snap.display}, srcLen=${snap.src}）`);

check(dialogs.length === 0, `无报错弹窗`);
check(errs.length === 0, `无未捕获异常${errs.length ? "：" + errs[0].slice(0, 120) : ""}`);

console.log(out.join("\n"));
console.log(fails === 0 ? `\n全部 ${out.filter((s) => s.includes("[通过]")).length} 项通过` : `\n有 ${fails} 项失败`);

chrome.kill();
server.close();
process.exit(fails ? 1 : 0);
