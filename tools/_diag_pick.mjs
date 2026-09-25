// 一次性验证：「打开文件」按钮的通道选择与降级（自包含 CDP）
// 背景：showOpenFilePicker 在跨源 iframe（预览面板）、非安全上下文、
// 旧浏览器里不可用会直接抛错，早期实现把非取消的异常也一并静默 return，
// 表现为按钮"点了没反应、导入不进来"。这里逐条验证降级逻辑：
//   1) 顶层安全上下文走 picker
//   2) 用户取消（AbortError）→ 静默退出，不弹 input
//   3) picker 正常返回句柄 → 直接把 File + 句柄交给 importFiles
//   4) 句柄读取失败 / picker 抛非取消异常 → 自动降级到 <input type="file">
//   5) 失败过一次后本会话不再尝试 picker
//   6) 没有该 API 的环境（旧浏览器/局域网 http）直接走 input
//   7) any iframe（含同源）判定为不可用，转 input
import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PORT = 8863;
const PORT_CDP = 9583;

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

const profile = path.join(ROOT, ".cdp-profile-pick");
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
// 阅读器出错会弹 alert，无头环境里会冻住主线程
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === "Page.javascriptDialogOpening") send("Page.handleJavaScriptDialog", { accept: true });
});

const out = [];
let fails = 0;
const check = (c, m) => { if (!c) fails++; out.push((c ? "  [通过] " : "  [失败] ") + m); };

async function openPage() {
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html` });
  for (let i = 0; i < 30; i++) {
    await sleep(800);
    const ok = await evalJs(`!!window.gushiReader`).catch(() => false);
    if (ok) { await sleep(600); return true; }
  }
  return false;
}
if (!(await openPage())) { console.log("页面没起来"); chrome.kill(); server.close(); process.exit(2); }

// --- 1) 顶层安全上下文的默认通道 ---
let info = await evalJs(`JSON.stringify(gushiReader.pickInfo())`);
info = JSON.parse(info);
check(info.inIframe === false, "顶层窗口 inIframe=false");
check(info.secure === true, "127.0.0.1 属安全上下文");
check(info.mode === (info.hasApi ? "picker" : "input"),
  `通道与 API 可用性一致（hasApi=${info.hasApi} → mode=${info.mode}）`);
check(info.blocked === false, "初始未被标记为降级");

// 通用桩：拦下 input.click，计数即可，不要让 headless 真去开系统对话框
await evalJs(`(function(){
  window.__clicks = 0;
  window.__pickerCalls = 0;
  window.__imports = null;
  var fi = document.getElementById("fileInput");
  fi.click = function(){ window.__clicks++; };
  window.__origImport = window.importFiles;
  window.importFiles = function(files, handles){
    window.__imports = { n: files.length, names: files.map(f => f.name), handles: handles ? handles.length : 0 };
  };
  return true;
})()`);

// --- 2) 用户取消：静默退出，不该弹 input ---
await evalJs(`window.showOpenFilePicker = function(){
  window.__pickerCalls++;
  return Promise.reject(Object.assign(new Error("The user aborted a request."), { name: "AbortError" }));
}`);
await evalJs(`pickFiles()`);
await sleep(300);
let v = await evalJs(`window.__clicks`);
check(v === 0, `用户取消时不降级（input.click 调用 ${v} 次）`);
info = JSON.parse(await evalJs(`JSON.stringify(gushiReader.pickInfo())`));
check(info.blocked === false, "用户取消不算失败，不标记降级");
check(info.lastError === null, "用户取消不记录错误");

// --- 3) picker 正常返回句柄 ---
await evalJs(`window.showOpenFilePicker = function(){
  window.__pickerCalls++;
  return Promise.resolve([{
    name: "假古籍.pdf",
    getFile: () => Promise.resolve(new File(["%PDF-1.4"], "假古籍.pdf", { type: "application/pdf" })),
  }]);
}`);
await evalJs(`pickFiles()`);
await sleep(300);
let imp = JSON.parse(await evalJs(`JSON.stringify(window.__imports)`));
check(!!imp && imp.n === 1, `句柄正常时把 File 交给 importFiles（收到 ${imp ? imp.n : 0} 个）`);
check(!!imp && imp.handles === 1, "句柄一并交给 importFiles（供「最近打开」一键重开）");
check(await evalJs(`window.__clicks`) === 0, "句柄正常时不降级");

// --- 4) 跨源 iframe 的典型异常：SecurityError → 自动降级 ---
await evalJs(`window.showOpenFilePicker = function(){
  window.__pickerCalls++;
  return Promise.reject(Object.assign(
    new Error("Cross origin sub frames aren't allowed to show a file picker."),
    { name: "SecurityError" }));
}`);
await evalJs(`pickFiles()`);
await sleep(300);
v = await evalJs(`window.__clicks`);
check(v === 1, `SecurityError 时自动降级到 input（input.click 调用 ${v} 次）`);
info = JSON.parse(await evalJs(`JSON.stringify(gushiReader.pickInfo())`));
check(info.blocked === true, "失败后标记为已降级");
check((info.lastError || "").includes("SecurityError"), `记录失败原因（${info.lastError}）`);

// --- 5) 已降级后不再尝试 picker ---
const callsBefore = await evalJs(`window.__pickerCalls`);
await evalJs(`pickFiles()`);
await sleep(300);
v = await evalJs(`window.__clicks`);
check(v === 2, `再次点击仍走 input（累计 ${v} 次）`);
check(await evalJs(`window.__pickerCalls`) === callsBefore, "降级后不再调用 showOpenFilePicker");

// --- 4b) 句柄读不出文件（getFile 失败）也要降级 ---
await openPage();   // 重载，重置 pickerBlocked
await evalJs(`(function(){
  window.__clicks = 0;
  window.__pickerCalls = 0;
  var fi = document.getElementById("fileInput");
  fi.click = function(){ window.__clicks++; };
  window.showOpenFilePicker = function(){
    window.__pickerCalls++;
    return Promise.resolve([{ name: "坏.pdf", getFile: () => Promise.reject(new Error("权限不足")) }]);
  };
  return true;
})()`);
await evalJs(`pickFiles()`);
await sleep(300);
v = await evalJs(`window.__clicks`);
check(v === 1, `句柄读不出文件时降级（input.click 调用 ${v} 次）`);
info = JSON.parse(await evalJs(`JSON.stringify(gushiReader.pickInfo())`));
check((info.lastError || "").includes("getFile"), `记录 getFile 失败（${info.lastError}）`);

// --- 6) 没有该 API 的环境（旧浏览器 / 局域网 http）---
await openPage();
await evalJs(`(function(){
  window.__clicks = 0;
  var fi = document.getElementById("fileInput");
  fi.click = function(){ window.__clicks++; };
  try{ delete window.showOpenFilePicker; }catch(e){ window.showOpenFilePicker = undefined; }
  return true;
})()`);
info = JSON.parse(await evalJs(`JSON.stringify(gushiReader.pickInfo())`));
check(info.hasApi === false && info.mode === "input", `无该 API 时直接走 input（hasApi=${info.hasApi}）`);
await evalJs(`pickFiles()`);
await sleep(300);
v = await evalJs(`window.__clicks`);
check(v === 1, `无该 API 时点击即弹 input（累计 ${v} 次）`);

// --- 7) 被 iframe 包住（预览面板同款场景）---
await evalJs(`(function(){
  var f = document.createElement("iframe");
  f.id = "probeFrame";
  f.src = "index.html";
  document.body.appendChild(f);
  return true;
})()`);
let frameReady = false;
for (let i = 0; i < 30; i++) {
  await sleep(600);
  const ok = await evalJs(`(function(){
    var f = document.getElementById("probeFrame");
    try{ return !!(f.contentWindow && f.contentWindow.gushiReader); }catch(e){ return false; }
  })()`).catch(() => false);
  if (ok) { frameReady = true; break; }
}
check(frameReady, "iframe 内页面已加载（用于验证嵌套场景）");
if (frameReady) {
  const nested = JSON.parse(await evalJs(`JSON.stringify(document.getElementById("probeFrame").contentWindow.gushiReader.pickInfo())`));
  check(nested.inIframe === true, "iframe 内 inIframe=true");
  check(nested.mode === "input", `iframe 内改用 input（mode=${nested.mode}）`);
  // 再确认纯函数判定与 mode 一致：iframe 里点按钮不该碰 picker
  await evalJs(`(function(){
    var w = document.getElementById("probeFrame").contentWindow;
    var d = w.document;
    w.__clicks = 0;
    var fi = d.getElementById("fileInput");
    fi.click = function(){ w.__clicks++; };
    w.__origPick = w.showOpenFilePicker;
    w.showOpenFilePicker = function(){ throw new Error("不该被调用"); };
    w.pickFiles();
    return true;
  })()`);
  await sleep(400);
  const nestedClicks = await evalJs(`document.getElementById("probeFrame").contentWindow.__clicks`);
  check(nestedClicks === 1, `iframe 内点击落到 input（累计 ${nestedClicks} 次）`);
}

// --- 8) 顶栏按钮确实连着这条通道（避免"按钮没绑上"这类假象）---
await openPage();
await evalJs(`(function(){
  window.__clicks = 0;
  window.__pickerCalls = 0;
  var fi = document.getElementById("fileInput");
  fi.click = function(){ window.__clicks++; };
  window.showOpenFilePicker = function(){
    window.__pickerCalls++;
    return Promise.reject(Object.assign(new Error("nope"), { name: "NotAllowedError" }));
  };
  return true;
})()`);
await evalJs(`document.getElementById("btnOpen").click()`);
await sleep(400);
check(await evalJs(`window.__pickerCalls`) === 1, "点击顶栏「打开文件」真的走到了 pickFiles");
check(await evalJs(`window.__clicks`) === 1, "该按钮在 picker 失败后也能落到 input");
await evalJs(`document.getElementById("btnOpen2").click()`);
await sleep(400);
check(await evalJs(`window.__clicks`) === 2, "空状态里的「打开文件」按钮同样可用");

console.log(out.join("\n"));
console.log(fails === 0 ? `\n全部通过（${out.length} 项）` : `\n失败 ${fails} 项 / 共 ${out.length} 项`);

ws.close();
chrome.kill();
server.close();
process.exit(fails === 0 ? 0 : 1);
