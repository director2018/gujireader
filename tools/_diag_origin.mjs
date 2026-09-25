// 诊断：为什么「这次能用，下次打开又不能用」
// A. 同一台服务、两个入口地址（127.0.0.1 与 localhost）是不是两套独立存储？
// B. 双击 index.html（file://）直开：演示库能否显示、提示条是否出现、worker 能否创建
// C. 固定入口 http://127.0.0.1:8899 的环境自检信息（含存储可持久性）
// D. 启动器幂等：服务已在运行时，重复双击不应报错，只应打开浏览器
import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PORT = 8869;
const PORT_CDP = 9589;
const ENTRY = "http://127.0.0.1:8899/";

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

const profile = path.join(ROOT, ".cdp-profile-origin");
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
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
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
async function goto(url) {
  await send("Page.navigate", { url });
  await sleep(2200);
}

await send("Page.enable");
await send("Runtime.enable");

const out = [];
let fails = 0;
const say = (s) => out.push(s);
const check = (c, m) => { if (!c) fails++; out.push((c ? "  [通过] " : "  [失败] ") + m); };

/* 固定入口是否已在运行（需要先双击启动器） */
let entryAlive = false;
try { entryAlive = (await fetch(ENTRY, { method: "HEAD" })).ok; } catch {}

const WRITE = `(async function(){
  var r = {};
  try { localStorage.setItem("gushi-origin-probe", "written"); r.ls = true; }
  catch(e){ r.ls = "ERR:" + e.name; }
  try {
    localStorage.setItem("gushi-reader-history", JSON.stringify([{ id: "probe", name: "探针古籍", page: 68, total: 124, kind: "local" }]));
    r.hist = true;
  } catch(e){ r.hist = "ERR:" + e.name; }
  try {
    await new Promise(function(res, rej){
      var q = indexedDB.open("gushi-probe-db", 1);
      q.onupgradeneeded = function(){ q.result.createObjectStore("s", { keyPath: "id" }); };
      q.onsuccess = function(){
        var db = q.result;
        var tx = db.transaction("s", "readwrite");
        tx.objectStore("s").put({ id: 1, v: "hello" });
        tx.oncomplete = function(){ db.close(); res(); };
        tx.onerror = function(){ rej(tx.error); };
      };
      q.onerror = function(){ rej(q.error); };
      setTimeout(function(){ rej(new Error("timeout")); }, 4000);
    });
    r.idb = true;
  } catch(e){ r.idb = "ERR:" + (e && (e.name || e.message)); }
  return JSON.stringify(r);
})()`;

const READ = `(async function(){
  var r = {};
  try { r.ls = localStorage.getItem("gushi-origin-probe"); } catch(e){ r.ls = "ERR:" + e.name; }
  try { r.dbs = (await indexedDB.databases()).map(function(d){ return d.name; }); }
  catch(e){ r.dbs = "ERR:" + e.name; }
  try { r.hist = JSON.parse(localStorage.getItem("gushi-reader-history") || "null"); }
  catch(e){ r.hist = "ERR"; }
  return JSON.stringify(r);
})()`;

/* ---------- A. 两个入口地址的存储隔离 ---------- */
say("=== A. 换入口地址后数据是否还在（127.0.0.1 ↔ localhost） ===");
const hostPort = entryAlive ? 8899 : PORT;
await goto(`http://127.0.0.1:${hostPort}/index.html`);
const wA = JSON.parse(await evalJs(WRITE));
say("  在 127.0.0.1 写入: " + JSON.stringify(wA));
await goto(`http://localhost:${hostPort}/index.html`);
const rB = JSON.parse(await evalJs(READ));
say("  在 localhost 读取: " + JSON.stringify({ ls: rB.ls, probeHist: (rB.hist || []).some((it) => it.id === "probe"), dbs: rB.dbs }));
check(rB.ls === null, "localStorage：另一个入口读不到（确认是两套独立存储）");
check(!(rB.hist || []).some((it) => it.id === "probe"), "「最近打开」记录：另一个入口读不到（界面上就是空的）");
check(Array.isArray(rB.dbs) && !rB.dbs.includes("gushi-probe-db"), "IndexedDB：另一个入口看不到已建的库（离线缓存/句柄同样读不到）");

await goto(`http://127.0.0.1:${hostPort}/index.html`);
const rA = JSON.parse(await evalJs(READ));
const probeBack = rA.ls === "written" && Array.isArray(rA.dbs) && rA.dbs.includes("gushi-probe-db");
check(probeBack, "回到 127.0.0.1 后数据完好（数据没丢，只是换了地方看）");

/* ---------- B. file:// 双击直开 ---------- */
say("");
say("=== B. 双击 index.html（file://）直接打开 ===");
const fileUrl = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");
await goto(fileUrl);
const fb = JSON.parse(await evalJs(`(async function(){
  var r = {};
  r.secure = window.isSecureContext === true;
  r.sheets = document.getElementById("track") ? document.getElementById("track").children.length : -1;
  r.embedded = !!window.__GUSHI_MANIFEST;
  r.pages = (window.gushiReader && window.gushiReader.state()) ? window.gushiReader.state().pages : -1;
  r.bar = document.getElementById("envBar").classList.contains("show");
  r.barText = document.getElementById("envBar").textContent.slice(0, 30);
  r.barFull = document.getElementById("envBar").textContent;
  try {
    r.idb = await new Promise(function(res){
      var q = indexedDB.open("gushi-file-probe", 1);
      q.onsuccess = function(){ q.result.close(); res(true); };
      q.onerror = function(){ res("ERR:" + (q.error && q.error.name)); };
      setTimeout(function(){ res("timeout"); }, 3000);
    });
  } catch(e){ r.idb = "ERR:" + e.name; }
  r.worker = await new Promise(function(res){
    try { var w = new Worker("vendor/pdfjs/pdf.worker.min.js"); w.terminate(); res(true); }
    catch(e){ res("ERR:" + e.name); }
  });
  return JSON.stringify(r);
})()`));
say("  环境快照: " + JSON.stringify(fb));
check(fb.embedded === true, "内嵌书库清单已加载（manifest.embed.js）");
check(fb.sheets > 0, "演示库正常显示（file:// 下不再是一片空白，页数=" + fb.pages + "）");
check(fb.bar === true && /启动右翻书/.test(fb.barFull || ""), "提示条明确给出「改用启动右翻书.bat」的做法");

/* ---------- C. 固定入口的环境自检 ---------- */
say("");
say("=== C. 固定入口 " + ENTRY + " 的环境自检 ===");
if (!entryAlive) {
  say("  （服务未运行：请先双击 启动右翻书.bat）");
} else {
  await goto(ENTRY + "index.html");
  const en = JSON.parse(await evalJs(`JSON.stringify(window.gushiReader.env())`));
  say("  env: " + JSON.stringify(en));
  check(en.origin === "http://127.0.0.1:8899", "入口地址固定为 http://127.0.0.1:8899");
  check(en.protocol === "http:", "走的是 http，不是 file://");
  check(en.lsOK === true && en.idbOK === true, "localStorage 与 IndexedDB 均可用");
  // 是否批准由浏览器按站点活跃度自行决定，这里只确认「已申请且结果已知」
  check(en.persisted === true || en.persisted === false,
        "已主动申请持久存储（本次浏览器答复：" + en.persisted + "）");
  check(en.picker === true, "支持 File System Access（打开过的书可直接重开，不必重选）");
}

/* ---------- D. 启动器幂等 ---------- */
say("");
say("=== D. 服务已在运行时重复启动 ===");
const again = spawnSync(process.execPath, [path.join(HERE, "serve.mjs"), "--no-open"], { encoding: "utf8", timeout: 15000 });
const againOut = (again.stdout || "") + (again.stderr || "");
const lastLine = againOut.trim().split("\n").filter(Boolean).slice(-1)[0] || "";
say("  退出码: " + again.status + " / 末行: " + lastLine.trim());
check(again.status === 3 || /已经在运行/.test(againOut), "识别出服务已在运行（不报错、不起第二个进程）");
check(!/EADDRINUSE/.test(againOut), "没有抛出端口占用错误");

console.log(out.join("\n"));
console.log("\n" + (fails === 0 ? "全部通过" : "失败 " + fails + " 项"));
try { ws.close(); } catch {}
chrome.kill();
server.close();
setTimeout(() => process.exit(0), 300);
