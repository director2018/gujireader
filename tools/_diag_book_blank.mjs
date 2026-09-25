// 诊断：翻书模式「页码在、内容空白」
// 场景 A：http 打开 -> 导入 PDF -> 切翻书 -> 跳中间页
// 场景 B：localStorage 预存 view=book -> 导入 PDF（开门即翻书）
// 场景 C：file:// 直开 -> 导入 PDF -> 切翻书（复刻用户"双击 index.html"的用法）
import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PORT = 8867;
const PORT_CDP = 9587;

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

const profile = path.join(ROOT, ".cdp-profile-bookblank");
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
const cons = [], errs = [], dialogs = [];

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === "Runtime.consoleAPICalled") {
    const txt = (m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(" ");
    cons.push(m.params.type + ": " + txt.slice(0, 300));
  }
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
async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  if (r.result?.data) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(HERE, name), Buffer.from(r.result.data, "base64"));
  }
}

await send("Page.enable");
await send("Runtime.enable");

const out = [];
const say = (s) => out.push(s);
let fails = 0;
const check = (c, m) => { if (!c) fails++; out.push((c ? "  [通过] " : "  [失败] ") + m); };
const resetLog = () => { cons.length = 0; errs.length = 0; dialogs.length = 0; };

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

/** 翻书视图快照：区域、叶子、图片、页码、状态 */
async function bookSnap() {
  return JSON.parse(await evalJs(`(function(){
    var area = document.getElementById("bookArea");
    var ar = area ? area.getBoundingClientRect() : {width:0,height:0};
    function leaf(id){
      var el = document.getElementById(id);
      if (!el) return null;
      var r = el.getBoundingClientRect();
      var im = el.querySelector("img");
      return { display: el.style.display, w: Math.round(r.width), h: Math.round(r.height),
               left: Math.round(r.left), cls: el.className,
               src: im ? (im.getAttribute("src")||"").slice(0,60) : null,
               nw: im ? im.naturalWidth : -1, complete: im ? im.complete : null };
    }
    var s = window.gushiReader.state();
    return JSON.stringify({
      view: document.body.dataset.view,
      bookDisplay: getComputedStyle(document.getElementById("book")).display,
      areaW: Math.round(ar.width), areaH: Math.round(ar.height),
      L: leaf("bookL"), R: leaf("bookR"), F: leaf("bookFull"),
      bookNum: (document.getElementById("bookNum")||{}).textContent,
      total: s.total, idx: s.idx, pend: s.pendingPages, failed: s.failedPages,
      curPending: (function(){ var p = document.querySelectorAll("#track .sheet"); return p.length; })(),
    });
  })()`));
}

async function gotoPage(n) {   // n 为 0 基
  await evalJs(`(function(){
    var s = document.getElementById("slider");
    s.value = ${n};
    s.dispatchEvent(new Event("input", { bubbles: true }));
    s.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
}

async function openUrl(url, clear) {
  await send("Page.navigate", { url });
  for (let i = 0; i < 24; i++) {
    await sleep(500);
    const ok = await evalJs(`!!window.gushiReader`).catch(() => false);
    if (ok) break;
  }
  if (clear) await evalJs(`try{ localStorage.clear(); sessionStorage.clear(); }catch(e){} true`);
}

/* ============ 场景 A：http 导入 -> 切翻书 -> 跳中间页 ============ */
say("=== A) http：导入 80 页 PDF -> 翻书 -> 跳第 60 页 ===");
await openUrl(`http://127.0.0.1:${PORT}/index.html`, true);
resetLog();
say("  drop: " + await dropPdf("big-book-80.pdf"));
await sleep(3500);
await evalJs(`document.getElementById("btnView").click(); true`);
for (let i = 0; i < 12; i++) {
  const v = await evalJs(`document.body.dataset.view`);
  out.push("  点击后 " + (i * 100) + "ms: " + v);
  await sleep(100);
}
await gotoPage(59);
for (let i = 0; i < 20; i++) {
  const v = await evalJs(`document.body.dataset.view`);
  out.push("  跳页后 " + (i * 100) + "ms: " + v);
  await sleep(100);
}
const dgA = JSON.parse(await evalJs(`JSON.stringify(window.gushiReader.diag())`));
out.push("  diag: " + JSON.stringify({ errors: dgA.errors, heals: dgA.heals, bookDisplay: dgA.bookDisplay, area: [dgA.areaW, dgA.areaH] }));
await sleep(3000);   // 给后台渲染留时间
say("  " + JSON.stringify(await bookSnap()));
check(dialogs.length === 0, `无报错弹窗`);
const A = await bookSnap();
check(A.view === "book", `处于翻书视图（${A.view}）`);
check(A.areaW > 300 && A.areaH > 200, `bookArea 有尺寸（${A.areaW}x${A.areaH}）`);
const leavesA = [A.L, A.R, A.F].filter(Boolean);
check(leavesA.some((l) => l.display !== "none" && l.nw > 0), `至少一片叶子带图且已解码（nw>0）`);
check(A.bookNum && A.bookNum.includes("60"), `页码标签正确（${A.bookNum}）`);
await shot("_diag_A_book.png");

/* ============ 场景 B：预存 view=book -> 导入（开门即翻书） ============ */
say("");
say("=== B) localStorage 预存 view=book -> 导入 PDF ===");
await openUrl(`http://127.0.0.1:${PORT}/index.html`, true);
await evalJs(`try{ localStorage.setItem("gushi-reader-view","book"); }catch(e){} true`);
resetLog();
say("  drop: " + await dropPdf("big-book-80.pdf"));
await sleep(4500);
const B = await bookSnap();
say("  " + JSON.stringify(B));
check(B.view === "book", `开门即翻书视图（${B.view}）`);
check([B.L, B.R, B.F].some((l) => l && l.display !== "none" && l.nw > 0), `第一页有图`);
check(dialogs.length === 0, `无报错弹窗`);
// 翻 3 页再跳中间
await gotoPage(59);
await sleep(4000);
const B2 = await bookSnap();
say("  跳 60 页后: " + JSON.stringify(B2));
check([B2.L, B2.R, B2.F].some((l) => l && l.display !== "none" && l.nw > 0), `跳页后当前页有图`);
await shot("_diag_B_book.png");

/* ============ 场景 C：file:// 直开 ============ */
say("");
say("=== C) file:// 直开 index.html -> 导入 PDF -> 翻书 ===");
const FILE_URL = "file:///" + ROOT.replace(/\\/g, "/") + "/index.html";
await openUrl(FILE_URL, true);
resetLog();
const canDrop = await evalJs(`!!window.gushiReader`);
if (!canDrop) {
  check(false, "file:// 下应用没能启动");
} else {
  say("  drop: " + await dropPdf("big-book-80.pdf"));
  await sleep(6000);
  const st = JSON.parse(await evalJs(`JSON.stringify(window.gushiReader.state())`));
  say("  state: " + JSON.stringify({ total: st.total, pend: st.pendingPages, failed: st.failedPages, title: st.title }));
  if (st.total > 0) {
    await evalJs(`document.getElementById("btnView").click(); true`);
    await sleep(800);
    await gotoPage(59);
    await sleep(5000);
    const C = await bookSnap();
    say("  " + JSON.stringify(C));
    check(C.view === "book", `翻书视图（${C.view}）`);
    check([C.L, C.R, C.F].some((l) => l && l.display !== "none" && l.nw > 0), `当前页有图（nw>0）`);
    check(dialogs.length === 0, `无报错弹窗（${JSON.stringify(dialogs)}）`);
    await shot("_diag_C_book_file.png");
  } else {
    say("  file:// 下 PDF 解析失败，失败/ pending 数见上");
    check(false, "file:// 下 PDF 解析出 0 页");
    await shot("_diag_C_book_file.png");
  }
}
say("");
say("控制台错误（去重后前 8 条）：");
[...new Set(errs)].slice(0, 8).forEach((e) => say("  ! " + e.split("\n")[0]));
say("console.warn（去重后前 8 条）：");
[...new Set(cons.filter((c) => c.startsWith("warn")))].slice(0, 8).forEach((e) => say("  ~ " + e.slice(0, 200)));

say("");
say("=".repeat(46));
say(fails ? `有 ${fails} 项失败` : `全部通过`);
console.log(out.join("\n"));
chrome.kill();
server.close();
process.exit(fails ? 1 : 0);
