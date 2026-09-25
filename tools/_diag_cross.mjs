// 诊断：翻书模式的「跨」——一屏该同时摊开左右两张纸
// 场景 A：80 页全单页扫描 -> 左右各一页（右 1 左 2），翻一次跨页号 +2
// 场景 B：混合书（单、单、对开、单、单、单）-> 切跨 [1,2] [3] [4,5] [6]
// 场景 C：只有一页的书 -> 整张居中
import http from "node:http";
import { readFile, writeFile } from "node:fs/promises";
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

const profile = path.join(ROOT, ".cdp-profile-cross");
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
async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  if (r.result?.data) await writeFile(path.join(HERE, name), Buffer.from(r.result.data, "base64"));
}
await send("Page.enable");
await send("Runtime.enable");

const out = [];
const say = (s) => out.push(s);
let fails = 0;
const check = (c, m) => { if (!c) fails++; out.push((c ? "  [通过] " : "  [失败] ") + m); };
const resetLog = () => { errs.length = 0; dialogs.length = 0; };

async function dropPdf(fileName) {
  const b64 = (await readFile(path.join(HERE, fileName))).toString("base64");
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
  for (let i = 0; i < 80; i++) {
    const d = await evalJs(`window.__pdfDone`);
    if (d !== "pending") return d;
    await sleep(500);
  }
  return "timeout";
}

const bookInfo = async () => JSON.parse(await evalJs(`JSON.stringify(window.gushiReader.bookInfo())`));
const bookNum = async () => await evalJs(`(document.getElementById("bookNum")||{}).textContent`);

async function leafSnap() {
  return JSON.parse(await evalJs(`(function(){
    function leaf(id){
      var el = document.getElementById(id);
      var im = el.querySelector("img");
      return { display: el.style.display, idx: el._leafIdx,
               nw: im ? im.naturalWidth : -1, src: im ? (im.getAttribute("src")||"").slice(0,40) : null };
    }
    return JSON.stringify({ L: leaf("bookL"), R: leaf("bookR"), F: leaf("bookFull") });
  })()`));
}

async function gotoPage(n) {
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

/* ---------- 断言辅助：一跨里左右纸的合理摆位 ---------- */
function assertSidePair(info, wantRight, wantLeft, tag) {
  const r = info.right, l = info.left;
  if (wantRight === null) {
    check(!r, `${tag}：右半不该有纸`);
  } else {
    check(!!r && r.idx === wantRight, `${tag}：右半是第 ${wantRight + 1} 页（实际 ${r ? r.idx + 1 : "无"}）`);
    if (r) check(r.left >= info.spineX - 1 && r.left - info.spineX < 24, `${tag}：右纸贴着书脊右缘（left ${r.left} vs 脊 ${info.spineX}）`);
  }
  if (wantLeft === null) {
    check(!l, `${tag}：左半不该有纸`);
  } else {
    check(!!l && l.idx === wantLeft, `${tag}：左半是第 ${wantLeft + 1} 页（实际 ${l ? l.idx + 1 : "无"}）`);
    if (l) check(l.left + l.w <= info.spineX + 1 && info.spineX - (l.left + l.w) < 24, `${tag}：左纸贴着书脊左缘（右缘 ${l.left + l.w} vs 脊 ${info.spineX}）`);
  }
}

/* ============ 场景 A：全单页扫描，左右各一页 ============ */
say("=== A) 80 页全单页：一屏摊开左右两页，翻一次跨 +2 ===");
await openUrl(`http://127.0.0.1:${PORT}/index.html`, true);
resetLog();
say("  drop: " + await dropPdf("big-book-80.pdf"));
await sleep(4000);
await evalJs(`window.gushiReader.setView("book"); true`);
await evalJs(`window.gushiReader.setDirection("right-to-left"); true`);
await sleep(500);
await sleep(1200);
let A = await bookInfo();
say("  bookInfo: " + JSON.stringify(A));
check(A.crossCount === 40, `80 页单页扫描切成 40 跨（实际 ${A.crossCount}）`);
check(A.crossKind === "pair", `第一跨是配对跨（${A.crossKind}）`);
assertSidePair(A, 0, 1, "A1");
check((await bookNum()).includes("1–2"), `页码标签报出跨内范围（${await bookNum()}）`);
await sleep(2500);
let lf = await leafSnap();
say("  leaves: " + JSON.stringify(lf));
check(lf.R.nw > 0 && lf.L.nw > 0, `左右两张纸都已出图（R ${lf.R.nw}px / L ${lf.L.nw}px）`);
await shot("_diag_cross_pair.png");

// 前进一跨
await evalJs(`document.getElementById("btnNext").click(); true`);
await sleep(2000);
const A2 = await bookInfo();
say("  翻一跨后: " + JSON.stringify({ cross: A2.cross, crossPages: A2.crossPages, num: await bookNum() }));
check(A2.cross === 1 && A2.crossPages[0] === 2 && A2.crossPages[1] === 3, `翻一跨后是第 3–4 页（${A2.crossPages.map((i) => i + 1).join("、")}）`);
check(A2.left && A2.right, `翻后左右仍各有一张纸`);
lf = await leafSnap();
check(lf.R.nw > 0 && lf.L.nw > 0, `翻后两页都出图（R ${lf.R.nw}px / L ${lf.L.nw}px）`);

// 后退回第一跨
await evalJs(`document.getElementById("btnPrev").click(); true`);
await sleep(2000);
const A3 = await bookInfo();
check(A3.cross === 0 && A3.crossPages[0] === 0, `后退回到第 1–2 页（${A3.crossPages.map((i) => i + 1).join("、")}）`);
check(A3.left && A3.right, `后退后左右仍各有一张纸`);
check(dialogs.length === 0, `无报错弹窗`);

/* ============ 场景 B：混合书（含对开页与落单尾页） ============ */
say("");
say("=== B) 混合书：单、单、对开、单、单、单 ===");
await openUrl(`http://127.0.0.1:${PORT}/index.html`, true);
resetLog();
say("  drop: " + await dropPdf("mixed-book.pdf"));
await sleep(3000);
await evalJs(`window.gushiReader.setView("book"); true`);
await evalJs(`window.gushiReader.setDirection("right-to-left"); true`);
await sleep(500);
await sleep(1000);
let B = await bookInfo();
say("  bookInfo: " + JSON.stringify(B));
check(B.crossCount === 4, `6 页切成 4 跨（实际 ${B.crossCount}）`);
const kinds = await evalJs(`JSON.stringify(window.gushiReader.bookInfo().crossCount && (function(){
  var out = [];
  for (var i = 0; i < 6; i++){
    document.getElementById("slider").value = i;
    document.getElementById("slider").dispatchEvent(new Event("input", { bubbles: true }));
    var bi = window.gushiReader.bookInfo();
    out.push(bi.crossKind + ":" + bi.crossPages.map(function(n){return n+1;}).join("-"));
  }
  return out;
})())`);
say("  各页所属跨: " + kinds);
check(kinds.includes("pair:1-2") && kinds.includes("full:3") && kinds.includes("pair:4-5") && kinds.includes("single:6"),
  `跨划分正确（${kinds}）`);

// 回到第 1 页，检查配对跨
await gotoPage(0); await sleep(900);
B = await bookInfo();
assertSidePair(B, 0, 1, "B-配对跨");
check((await bookNum()).includes("1–2"), `配对跨页码（${await bookNum()}）`);
await sleep(1500);
lf = await leafSnap();
check(lf.R.nw > 0 && lf.L.nw > 0, `配对跨左右都出图（R ${lf.R.nw} / L ${lf.L.nw}）`);

// 对开页：整张居中独占一屏
await gotoPage(2); await sleep(1500);
const Bf = await bookInfo();
say("  对开页: " + JSON.stringify(Bf));
check(Bf.crossKind === "full", `第 3 页判为对开整张（${Bf.crossKind}）`);
check(!!Bf.full && !Bf.left && !Bf.right, `对开页只占整张槽，左右槽不放纸`);
if (Bf.full) {
  const center = Bf.full.left + Bf.full.w / 2;
  check(Math.abs(center - Bf.spineX) <= 2, `整张以书脊为中心（中心 ${Math.round(center)} vs 脊 ${Bf.spineX}）`);
  check(Bf.full.w > Bf.h * 1.2, `整张宽高比是横向的（宽 ${Bf.full.w}，纸高 ${Bf.h}）`);
}
check((await bookNum()).includes("第 3 页"), `页码标签（${await bookNum()}）`);
await sleep(1500);
lf = await leafSnap();
check(lf.F.nw > 0 && lf.L.display === "none" && lf.R.display === "none", `整张出图且左右槽为空（F ${lf.F.nw}px）`);
await shot("_diag_cross_full.png");

// 对开页翻页：淡换到下一跨
await evalJs(`document.getElementById("btnNext").click(); true`);
await sleep(1600);
const Bn = await bookInfo();
check(Bn.crossKind === "pair" && Bn.crossPages[0] === 3, `对开页之后接回配对跨（${Bn.crossPages.map((i) => i + 1).join("、")}）`);

// 落单尾页
await gotoPage(5); await sleep(1200);
const Bs = await bookInfo();
say("  尾页: " + JSON.stringify(Bs));
check(Bs.crossKind === "single", `第 6 页落单成一跨（${Bs.crossKind}）`);
check(!!Bs.right && !Bs.left, `落单页摆在先读侧（右）`);
check((await bookNum()).includes("第 6 页"), `落单页页码（${await bookNum()}）`);
check(dialogs.length === 0, `无报错弹窗`);

/* ============ 场景 C：只有一页 ============ */
say("");
say("=== C) 只有一页的书：整张居中 ===");
await openUrl(`http://127.0.0.1:${PORT}/index.html`, true);
resetLog();
say("  drop: " + await dropPdf("one-page.pdf"));
await sleep(3000);
await evalJs(`window.gushiReader.setView("book"); true`);
await evalJs(`window.gushiReader.setDirection("right-to-left"); true`);
await sleep(500);
await sleep(1200);
const C = await bookInfo();
say("  bookInfo: " + JSON.stringify(C));
check(C.total === 1, `只有 1 页（${C.total}）`);
check(C.crossCount === 1 && !!C.full && !C.left && !C.right,
  `切成 1 跨、按整张居中摆（跨类型 ${C.crossKind}，整张槽 ${!!C.full}）`);
if (C.full) check(Math.abs((C.full.left + C.full.w / 2) - C.spineX) <= 2, `居中（中心 ${Math.round(C.full.left + C.full.w / 2)} vs 脊 ${C.spineX}）`);
await sleep(1500);
lf = await leafSnap();
check(lf.F.nw > 0, `唯一那页出图（${lf.F.nw}px）`);
check(dialogs.length === 0, `无报错弹窗`);

say("");
say("控制台错误（去重后前 8 条）：");
[...new Set(errs)].slice(0, 8).forEach((e) => say("  ! " + e.split("\n")[0]));

say("");
say("=".repeat(46));
say(fails ? `有 ${fails} 项失败` : `全部通过`);
console.log(out.join("\n"));
chrome.kill();
server.close();
process.exit(fails ? 1 : 0);
