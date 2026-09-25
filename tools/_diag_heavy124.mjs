// 诊断：124 页大部头（复刻用户滇缅路日记的页数规模）
// 全书后台渲染跑完 -> 翻书视图跳第 68 页 -> 检查叶子与内存
import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PORT = 8870;
const PORT_CDP = 9590;

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
const profile = path.join(ROOT, "tools/.cdp-profile-heavy124");
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
const errs = [], cons = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pendingMap.has(m.id)) { pendingMap.get(m.id)(m); pendingMap.delete(m.id); return; }
  if (m.method === "Runtime.exceptionThrown") errs.push(m.params.exceptionDetails?.exception?.description || "?");
  if (m.method === "Runtime.consoleAPICalled") {
    const txt = (m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(" ");
    if (m.params.type === "warning" || m.params.type === "error") cons.push(m.params.type + ": " + txt.slice(0, 200));
  }
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
async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  if (r.result?.data) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(HERE, name), Buffer.from(r.result.data, "base64"));
  }
}

await send("Page.enable");
await send("Runtime.enable");
await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html` });
for (let i = 0; i < 24; i++) { await sleep(500); if (await evalJs(`!!window.gushiReader`).catch(() => false)) break; }
await evalJs(`try{ localStorage.clear(); }catch(e){} true`);

const out = [];
const say = (s) => out.push(s);
let fails = 0;
const check = (c, m) => { if (!c) fails++; out.push((c ? "  [通过] " : "  [失败] ") + m); };

// 导入 124 页
const b64 = (await readFile(path.join(ROOT, "tools", "big-book-124.pdf"))).toString("base64");
await evalJs(`window.__pdfB64 = ${JSON.stringify(b64)}; true`);
await send("Runtime.evaluate", {
  expression: `(function(){
    var bin = atob(window.__pdfB64);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    var f = new File([arr], "滇缅路日记-124页测试.pdf", { type: "application/pdf" });
    var dt = new DataTransfer(); dt.items.add(f);
    window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    return true;
  })()`, returnByValue: true, awaitPromise: true,
});
await sleep(3000);
const st0 = JSON.parse(await evalJs(`JSON.stringify(window.gushiReader.state())`));
say("解析: total=" + st0.total + " title=" + st0.title);
check(st0.total === 124, `解析出 124 页（实际 ${st0.total}）`);

// 等全书后台渲染完成（最多 180s），每 5s 报一次进度
let last = null;
for (let i = 0; i < 36; i++) {
  const s = JSON.parse(await evalJs(`JSON.stringify(window.gushiReader.state())`));
  if (s.pendingPages !== last) { say(`  渲染进度: 待渲染 ${s.pendingPages} / 失败 ${s.failedPages}`); last = s.pendingPages; }
  if (s.pendingPages === 0) break;
  await sleep(5000);
}
const st1 = JSON.parse(await evalJs(`JSON.stringify(window.gushiReader.state())`));
check(st1.pendingPages === 0, `全书渲染完成（剩 ${st1.pendingPages} 页未渲染）`);
check(st1.failedPages === 0, `没有失败页（${st1.failedPages}）`);
const mem = await evalJs(`performance.memory ? Math.round(performance.memory.usedJSHeapSize/1048576) : -1`);
say(`  JS 堆内存: ${mem} MB`);

// 翻书视图 + 跳 68 页
await evalJs(`document.getElementById("btnView").click(); true`);
await sleep(800);
await evalJs(`(function(){ var s = document.getElementById("slider"); s.value = "67"; s.dispatchEvent(new Event("input",{bubbles:true})); return true; })()`);
await sleep(4000);
const d = JSON.parse(await evalJs(`JSON.stringify(window.gushiReader.diag())`));
say("  diag: " + JSON.stringify({ view: d.datasetView, bookDisplay: d.bookDisplay, area: [d.areaW, d.areaH],
  leaves: d.leaves.map((l) => l.id + ":" + l.display + ":" + l.nw).join(" "), trackPages: d.trackPages,
  pending: d.pendingPages, failed: d.failedPages, errors: d.errors.length, heals: d.heals.length }));
check(d.datasetView === "book", `翻书视图生效`);
check(d.areaW > 300 && d.areaH > 200, `bookArea 有尺寸（${d.areaW}x${d.areaH}）`);
check(d.leaves.some((l) => l.display !== "none" && l.nw > 0), `当前页有图`);
check(d.bookNum || true, "");
check(d.errors.length === 0, `无内部错误（${JSON.stringify(d.errors.slice(0, 2))}）`);
const bn = await evalJs(`document.getElementById("bookNum").textContent`);
check(bn.includes("68"), `页码标签是第 68 页（${bn}）`);
await shot("_diag_heavy124_book.png");
say("");
say("console 警告/错误（去重前 6 条）:");
[...new Set(cons)].slice(0, 6).forEach((l) => say("  ~ " + l));
say("页面异常: " + (errs.length ? errs.slice(0, 3).join(" | ").slice(0, 300) : "无"));

say("");
say("=".repeat(46));
say(fails ? `有 ${fails} 项失败` : `全部通过`);
console.log(out.join("\n"));
chrome.kill();
server.close();
process.exit(fails ? 1 : 0);
