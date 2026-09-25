// 诊断：PDF 导入「看不到页面」到底卡在哪一环
// 1) 正常网络导入 PDF
// 2) 只拦 CDN（模拟国内连不上 cdnjs）—— 应走本地 vendor 副本，照样能开
// 3) CDN 与本地副本都拿不到 —— 应给出说人话的错误提示，而不是"什么都没有"
// 4) 拦着 CDN 测「最近打开」里 PDF 的一键重开（导入 -> 缓存 -> 刷新 -> 点历史）
import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PORT = 8866;
const PORT_CDP = 9586;

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

const profile = path.join(ROOT, ".cdp-profile-pdfdiag");
const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
  "--disable-extensions", "--window-size=1600,1000",
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
const cons = [], errs = [], dialogs = [], netFail = [];

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === "Runtime.consoleAPICalled") {
    const txt = (m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(" ");
    cons.push(m.params.type + ": " + txt);
  }
  if (m.method === "Runtime.exceptionThrown") {
    errs.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || "?");
  }
  if (m.method === "Page.javascriptDialogOpening") {
    dialogs.push(m.params.message);
    send("Page.handleJavaScriptDialog", { accept: true });
  }
  if (m.method === "Network.loadingFailed") netFail.push((m.params.errorText || "?") + " " + (m.params.blockedReason || ""));
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
await send("Network.enable");
await send("Network.setCacheDisabled", { cacheDisabled: true });

const out = [];
const say = (s) => out.push(s);
let fails = 0;
const check = (c, m) => { if (!c) fails++; out.push((c ? "  [通过] " : "  [失败] ") + m); };

async function reset() { cons.length = 0; errs.length = 0; dialogs.length = 0; netFail.length = 0; }

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

async function snap() {
  return evalJs(`(function(){
    var s = window.gushiReader.state();
    return JSON.stringify({
      total: s.total, idx: s.idx, pending: s.pendingPages, failed: s.failedPages, title: s.title,
      progressOn: document.getElementById("progress").classList.contains("on"),
      emptyShown: document.getElementById("empty").classList.contains("show"),
      shown: [].slice.call(document.querySelectorAll("#track .sheet img")).filter(function(i){ return i.getAttribute("src"); }).length,
      pdf: window.gushiReader.pdfInfo(),
    });
  })()`).catch((e) => "eval 失败: " + e.message);
}

async function openFresh() {
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html` });
  for (let i = 0; i < 24; i++) {
    await sleep(500);
    const ok = await evalJs(`!!window.gushiReader`).catch(() => false);
    if (ok) break;
  }
}

/* ============ 1) 正常网络 ============ */
say("=== 1) 正常网络导入 PDF ===");
await openFresh();
await evalJs(`try{ localStorage.clear(); }catch(e){} true`);
await reset();
say("  drop: " + await dropPdf("big-book-80.pdf"));
await sleep(4000);
say("  " + await snap());
check(dialogs.length === 0, `没有报错弹窗（${JSON.stringify(dialogs)}）`);
const s1 = JSON.parse(await snap());
check(s1.total === 80, `解析出 80 页（实际 ${s1.total}）`);
check(s1.shown > 0, `页面上已有渲染出来的图（${s1.shown} 张）`);
check(s1.pdf.source === "预载" || s1.pdf.source === "本地", `pdf.js 从本地副本加载（source=${s1.pdf.source}）`);
check(String(s1.pdf.worker).includes("vendor/pdfjs"), `worker 也指向本地（${s1.pdf.worker}）`);

/* ============ 2) 只拦 CDN ============ */
say("");
say("=== 2) 只拦 CDN（模拟连不上 cdnjs）===");
await send("Network.setBlockedURLs", { urls: ["*cdnjs.cloudflare.com*", "*cdn.jsdelivr.net*", "*unpkg.com*"] });
await openFresh();
await evalJs(`try{ localStorage.clear(); }catch(e){} true`);
await reset();
say("  drop: " + await dropPdf("big-book-80.pdf"));
await sleep(5000);
say("  " + await snap());
const s2 = JSON.parse(await snap());
check(dialogs.length === 0, `CDN 不可达时不再报错（弹窗：${JSON.stringify(dialogs)}）`);
check(s2.total === 80 && s2.shown > 0, `照样解析出 80 页并出图（total=${s2.total}, shown=${s2.shown}）`);
check(s2.pdf.source === "预载" || s2.pdf.source === "本地", `用的是本地副本（source=${s2.pdf.source}）`);

/* ============ 3) 本地副本也拿不到 ============ */
say("");
say("=== 3) 本地副本与 CDN 都拿不到 ===");
await send("Network.setBlockedURLs", { urls: ["*cdnjs.cloudflare.com*", "*vendor/pdfjs*"] });
await openFresh();
await reset();
say("  drop: " + await dropPdf("big-book-80.pdf"));
await sleep(3000);
say("  " + await snap());
check(dialogs.length === 1, `给出明确弹窗（实际 ${dialogs.length} 个）`);
check(dialogs.length && dialogs[0].includes("vendor/pdfjs"), `提示里说清了缺什么（${JSON.stringify(dialogs[0] && dialogs[0].slice(0, 60))}）`);

/* ============ 4) 最近打开：重开 PDF ============ */
say("");
say("=== 4) 只拦 CDN 时，「最近打开」里的 PDF 能否一键重开 ===");
await send("Network.setBlockedURLs", { urls: ["*cdnjs.cloudflare.com*"] });
await openFresh();
await evalJs(`try{ localStorage.clear(); }catch(e){} true`);
await reset();
say("  先导入一次（写入文件缓存）：" + await dropPdf("big-book-80.pdf"));
await sleep(4000);
const cacheOk = await evalJs(`loadBookFiles(readHistory()[0].id).then(function(v){ return v && v.files ? v.files.length + " 个文件 / " + v.files[0].name : "无缓存"; })`);
say("  IndexedDB 缓存：" + cacheOk);
await reset();
await openFresh();     // 刷新：内存里的文件没了，只剩 IndexedDB 缓存
await sleep(2500);
const hist = JSON.parse(await evalJs(`JSON.stringify(gushiReader.history())`));
say("  刷新后历史：" + JSON.stringify(hist.map((h) => ({ name: h.name, kind: h.kind, page: h.page }))));
check(hist.some((h) => h.kind === "file"), "历史里记下了这本 PDF");

// 明确点「那本 PDF」那一行，而不是碰运气点第一行
const rowInfo = JSON.parse(await evalJs(`JSON.stringify((function(){
  var rows = [].slice.call(document.querySelectorAll(".hp-item"));
  var hit = null;
  rows.forEach(function(r){
    if ((r.textContent || "").indexOf("big-book-80") >= 0) hit = r;
  });
  if (!hit) return { found: false, rows: rows.map(function(r){ return r.textContent; }) };
  var sub = hit.querySelector(".hp-sub");
  var info = { found: true, text: hit.textContent, reopen: sub ? sub.textContent : "",
               hasId: hit.hasAttribute("data-hist-id"), id: hit.getAttribute("data-hist-id") };
  hit.click();
  return info;
})())`));
say("  点的那一行：" + JSON.stringify(rowInfo));
check(rowInfo.found, "历史列表里找到了这本 PDF 的行");
check(rowInfo.found && rowInfo.reopen.includes("可一键重开"), `列表文案提示可一键重开（${rowInfo.rowInfo && ""}${rowInfo.reopen}）`);
await sleep(6000);
say("  " + await snap());
const s4 = JSON.parse(await snap());
check(dialogs.length === 0, `重开过程没有报错弹窗（${JSON.stringify(dialogs)}）`);
check(!s4.emptyShown, "没有弹「请重新选择文件」的兜底面板");
check(s4.total === 80 && s4.shown > 0, `凭缓存直接重开成功（total=${s4.total}, shown=${s4.shown}）`);

/* ============ 5) 磁盘演示书（local）也能重开 ============ */
say("");
say("=== 5) 历史里的磁盘演示书（local）===");
await reset();
const localRow = JSON.parse(await evalJs(`JSON.stringify((function(){
  var rows = [].slice.call(document.querySelectorAll(".hp-item"));
  var hit = null;
  rows.forEach(function(r){ if ((r.textContent||"").indexOf("古籍演示本") >= 0) hit = r; });
  if (!hit) return { found: false };
  var item = gushiReader.history().filter(function(h){ return h.name.indexOf("古籍演示本") >= 0; })[0] || {};
  hit.click();
  return { found: true, hasSrc: !!item.src, kind: item.kind };
})())`));
say("  " + JSON.stringify(localRow));
await sleep(2500);
const s5 = JSON.parse(await snap());
check(dialogs.length === 0, `重开磁盘书没有报错（${JSON.stringify(dialogs)}）`);
check(!s5.emptyShown, "磁盘书没有误弹「请重新选择文件」面板");
check(s5.total === 6 && s5.shown > 0, `磁盘书重开成功（total=${s5.total}, shown=${s5.shown}）`);

say("");
say("=".repeat(46));
say(fails ? `有 ${fails} 项失败` : `全部通过（共 ${out.filter((l) => l.includes("[通过]")).length + fails} 项）`);
console.log(out.join("\n"));
chrome.kill();
server.close();
process.exit(fails ? 1 : 0);
