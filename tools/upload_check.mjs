// 上传功能端到端测试
// 用法: node tools/upload_check.mjs
//
// 用无头浏览器打开阅读器，通过 CDP 注入一个 DataTransfer 的文件，
// 模拟"把 PDF 拖进窗口"，然后检查是否成功解析并进入阅读状态。

import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PORT = 8813;

const MIME = {
  ".html": "text/html;charset=utf-8",
  ".json": "application/json;charset=utf-8",
  ".png": "image/png",
  ".pdf": "application/pdf",
  ".js": "text/javascript;charset=utf-8",
};

const server = http.createServer(async (req, res) => {
  let p = decodeURIComponent((req.url || "/").split("?")[0]);
  if (p === "/") p = "/index.html";
  try {
    const data = await readFile(path.join(ROOT, p));
    res.writeHead(200, { "Content-Type": MIME[path.extname(p).toLowerCase()] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404); res.end("404");
  }
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
console.log(`静态服务器: http://127.0.0.1:${PORT}/`);

const CHROME = [
  "C:\\Users\\DELL\\.agent-browser\\browsers\\chrome-153.0.8010.47\\chrome.exe",
  "C:\\Users\\DELL\\.agent-browser\\browsers\\chrome-152.0.7977.64\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((c) => existsSync(c));

if (!CHROME) { console.log("未找到浏览器"); server.close(); process.exit(0); }

// 用 CDP 驱动：起 Chrome 带远程调试端口
const PORT_CDP = 9333;
const profile = path.join(ROOT, ".cdp-profile");
const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
  "--disable-extensions", `--remote-debugging-port=${PORT_CDP}`,
  `--user-data-dir=${profile}`,
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(2500);

// 拿 webSocketDebuggerUrl
async function getWs() {
  for (let i = 0; i < 20; i++) {
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

// 极简 CDP 客户端（Node 22 自带 WebSocket）
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
async function evalJs(expr, awaitPromise = false) {
  const r = await send("Runtime.evaluate", {
    expression: expr, returnByValue: true, awaitPromise,
  });
  if (r.result?.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.exception?.description || "eval 出错");
  }
  return r.result?.result?.value;
}

await send("Page.enable");
await send("Runtime.enable");

// 打开页面
await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html` });
await sleep(3500);

console.log("\n右翻书古籍阅读器 · 上传功能测试");
console.log("=".repeat(52));

const out = [];
let fails = 0;
const check = (c, m) => { if (!c) fails++; out.push((c ? "  [通过] " : "  [失败] ") + m); };

// 1) 页面基础状态
const base = await evalJs(`JSON.stringify({
  hasDropzone: !!document.getElementById('dropzone'),
  hasFileInput: !!document.getElementById('fileInput'),
  hasOpenBtn: !!document.getElementById('btnOpen'),
  accept: document.getElementById('fileInput').getAttribute('accept'),
  multi: document.getElementById('fileInput').hasAttribute('multiple'),
  pdfjs: typeof window.pdfjsLib
})`);
const b = JSON.parse(base);
check(b.hasDropzone, "拖放覆盖层存在");
check(b.hasFileInput, "文件输入元素存在");
check(b.hasOpenBtn, "「打开文件」按钮存在");
check(/pdf/.test(b.accept || ""), `文件类型过滤包含 PDF（accept="${b.accept}"）`);
check(b.multi, "支持一次选多个文件");

// 2) 拖动时覆盖层出现
await evalJs(`(function(){
  var dt = new DataTransfer();
  window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles:true }));
  return document.getElementById('dropzone').classList.contains('on');
})()`);
const dzOn = await evalJs(`document.getElementById('dropzone').classList.contains('on')`);
check(dzOn === true, "拖入文件时显示「松手即开始阅读」覆盖层");

const dzOff = await evalJs(`(function(){
  window.dispatchEvent(new DragEvent('dragleave', { bubbles:true }));
  return document.getElementById('dropzone').classList.contains('on');
})()`);
check(dzOff === false, "拖离后覆盖层自动隐藏");

// 3) 真实拖放一个 PDF
const pdfPath = path.join(ROOT, "tools", "demo-book.pdf");
if (!existsSync(pdfPath)) {
  console.log("\n缺少测试 PDF，跳过拖放测试。");
} else {
  const b64 = (await readFile(pdfPath)).toString("base64");
  console.log(`  测试文件: demo-book.pdf (${(b64.length * 3 / 4 / 1048576).toFixed(1)} MB)`);

  // 把文件塞进页面，再构造 drop 事件
  await evalJs(`
    window.__pdfB64 = ${JSON.stringify(b64)};
    window.__dropped = null;
  `);

  await evalJs(`
    (async function(){
      try{
        var bin = atob(window.__pdfB64);
        var arr = new Uint8Array(bin.length);
        for (var i=0;i<bin.length;i++) arr[i] = bin.charCodeAt(i);
        var file = new File([arr], "demo-book.pdf", { type: "application/pdf" });
        var dt = new DataTransfer();
        dt.items.add(file);
        window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles:true, cancelable:true }));
        window.__dropped = "ok";
      }catch(e){ window.__dropped = "err: " + e.message; }
    })()
  `, false);

  await sleep(500);
  const droppedOk = await evalJs(`window.__dropped`);
  check(droppedOk === "ok", `成功派发 drop 事件（${droppedOk}）`);

  // 等解析完成（PDF 较大，给足时间）
  console.log("  等待 PDF 解析…");
  let ready = false;
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const st = await evalJs(`JSON.stringify({
      prog: document.getElementById('progress').classList.contains('on'),
      text: document.getElementById('progText').textContent,
      sub: document.getElementById('progSub').textContent,
      pages: document.querySelectorAll('#track .page').length,
      empty: document.getElementById('empty').classList.contains('show'),
      title: document.getElementById('bookTitle').textContent
    })`);
    const s = JSON.parse(st);
    if (i % 3 === 0) console.log(`    ${s.text} ${s.sub} | 已渲染 ${s.pages} 页`);
    if (!s.prog && s.pages > 0) { ready = true; console.log(`    完成：${s.pages} 页`); break; }
    if (s.empty) { console.log("    回到空状态，解析可能失败"); break; }
  }
  check(ready, "PDF 解析完成并渲染出页面");

  if (ready) {
    // 懒渲染：解析是秒级的，图片由后台队列补齐。等全书就绪再做结构断言
    let pending = -1;
    for (let i = 0; i < 90; i++) {
      pending = await evalJs(`window.gushiReader.state().pendingPages`);
      if (pending === 0) break;
      await sleep(1000);
    }
    check(pending === 0, `后台渲染补齐全书（剩余 ${pending} 页）`);

    const st2 = await evalJs(`JSON.stringify({
      pages: document.querySelectorAll('#track .page').length,
      caps: Array.from(document.querySelectorAll('#track .page .pnum')).map(function(e){return e.textContent;}),
      srcs: Array.from(document.querySelectorAll('#track .page')).map(function(e){return Number(e.getAttribute('data-src'));}),
      slots: Array.from(document.querySelectorAll('#track .page')).map(function(e){return Number(e.getAttribute('data-slot'));}),
      title: document.getElementById('bookTitle').textContent,
      label: document.getElementById('pageLabel').innerText,
      firstSrc: (document.querySelector('#track .page img') || {getAttribute:function(){return '';}}).getAttribute('src').slice(0,5),
      prevDis: document.getElementById('btnPrev').disabled,
      nextDis: document.getElementById('btnNext').disabled
    })`);
    const s = JSON.parse(st2);
    console.log(`\n  书名: ${s.title}`);
    console.log(`  轨道顺序（从左到右）: ${s.caps.join(" | ")}`);
    console.log(`  首格 data-src: ${s.srcs[0]}（0 = 第1页）`);
    console.log(`  首图 src 前缀: ${s.firstSrc}…`);

    check(s.pages === 6, `渲染出 6 页（实际 ${s.pages}）`);
    check(s.title === "demo-book", `书名取自文件名（实际「${s.title}」）`);
    // 左开本（默认）：第 1 页在最左，DOM 从左到右为 第1页…末页
    check(
      s.caps[0] === "第 1 页" && s.caps[5] === "第 6 页",
      `左开本页序：DOM 从左到右为 第1页…第6页（实际 ${s.caps[0]} … ${s.caps[5]}）`
    );
    check(
      JSON.stringify(s.srcs.slice().sort((a, b) => a - b)) === JSON.stringify([0, 1, 2, 3, 4, 5]),
      "六页各出现一次，没有重复或缺失"
    );
    check(
      s.srcs.every((v, i) => s.slots[i] === v),
      "左开本映射式 slot = src 成立"
    );
    check(s.label.replace(/\s/g, "") === "1/6", `页码指示为 1 / 6（实际 ${s.label}）`);
    check(s.firstSrc === "blob:", `页面图片使用本机 blob 地址（实际前缀「${s.firstSrc}」）`);
    check(s.prevDis === true, "初始「上一页」为禁用态");
    check(s.nextDis === false, "初始「下一页」为可用态");

    // 翻页
    const nav = await evalJs(`(function(){
      var L = function(){ return document.getElementById('pageLabel').innerText.replace(/\\s/g,''); };
      var a = L();
      document.getElementById('btnNext').click(); var b = L();
      document.getElementById('btnNext').click(); var c = L();
      document.getElementById('btnPrev').click(); var d = L();
      return a + " " + b + " " + c + " " + d;
    })()`);
    check(nav === "1/6 2/6 3/6 2/6", `导入后翻页正常 1/6→2/6→3/6→2/6（实际 ${nav}）`);
  }
}

console.log("\n" + out.join("\n"));
console.log("=".repeat(52));
console.log(fails === 0 ? `全部通过（共 ${out.length} 项）` : `存在 ${fails} 项失败（共 ${out.length} 项）`);

ws.close();
chrome.kill();
server.close();
process.exit(fails === 0 ? 0 : 1);
