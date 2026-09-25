// 交互端到端测试（CDP 驱动真实 Chrome）
// 用法: node tools/interact_check.mjs [big-book-80.pdf]
//
// 覆盖用户反馈的四个问题：
//   1. 底色可选（五种护眼配色）+ 切换生效 + 可记忆
//   2. 大 PDF（>59 页）载入后仍然有内容，不再空白
//   3. 「上一页」确实是上一页（页码变小）
//   4. 「左开本」确实是第 1 页在最左
//
// 顺带回归：翻页按钮/键盘/滑动的语义与装帧方向解耦。

import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PORT = 8821;
const PORT_CDP = 9341;

// 大 PDF 路径：命令行参数优先，否则找 tools/big-book-*.pdf
const bigArg = process.argv[2];
const bigCandidates = [
  bigArg ? path.resolve(bigArg) : null,
  path.join(ROOT, "tools", "big-book-80.pdf"),
].filter(Boolean);
const BIG_PDF = bigCandidates.find((p) => existsSync(p));

const MIME = {
  ".html": "text/html;charset=utf-8",
  ".json": "application/json;charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
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
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((c) => existsSync(c));

if (!CHROME) { console.log("未找到浏览器，跳过。"); server.close(); process.exit(0); }

// 给足内存，避免无头环境因内存上限先挂（这不是被测代码的问题）
const profile = path.join(ROOT, ".cdp-profile-interact");
const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
  "--disable-extensions",
  "--js-flags=--max-old-space-size=4096",
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
const consoleErrors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  // 收集页面里的 console 异常，便于定位
  if (m.method === "Runtime.exceptionThrown") {
    const d = m.params?.exceptionDetails;
    consoleErrors.push(d?.exception?.description || d?.text || "unknown");
  }
  if (m.method === "Runtime.consoleAPICalled" && m.params?.type === "error") {
    consoleErrors.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
  }
};
function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve) => { pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
}
async function evalJs(expr, awaitPromise = false) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise });
  if (r.result?.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.exception?.description || "eval 出错");
  }
  return r.result?.result?.value;
}
async function evalJson(expr, awaitPromise = false) {
  const v = await evalJs(expr, awaitPromise);
  return typeof v === "string" ? JSON.parse(v) : v;
}

await send("Page.enable");
await send("Runtime.enable");

const out = [];
let fails = 0;
const check = (c, m) => { if (!c) fails++; out.push((c ? "  [通过] " : "  [失败] ") + m); };

async function goto(url) {
  await send("Page.navigate", { url });
  await sleep(3000);
}

// 派发一个 drop 事件把本地文件塞进去（复用上传测试的做法）
async function dropFile(localPath, filename, mime) {
  const b64 = (await readFile(localPath)).toString("base64");
  await evalJs(`window.__f = { b64: ${JSON.stringify(b64)}, name: ${JSON.stringify(filename)}, mime: ${JSON.stringify(mime)} }; true`);
  await evalJs(`
    (async function(){
      try{
        var bin = atob(window.__f.b64);
        var arr = new Uint8Array(bin.length);
        for (var i=0;i<bin.length;i++) arr[i] = bin.charCodeAt(i);
        var file = new File([arr], window.__f.name, { type: window.__f.mime });
        var dt = new DataTransfer();
        dt.items.add(file);
        window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles:true, cancelable:true }));
        window.__dropOk = "ok";
      }catch(e){ window.__dropOk = "err: " + e.message; }
    })()
  `, false);
  return evalJs(`window.__dropOk`);
}

/** 等载入完成（进度层消失且有页面渲染出来） */
async function waitReady(timeoutSec = 180) {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < timeoutSec * 1000) {
    await sleep(2000);
    const s = await evalJson(`JSON.stringify({
      prog: document.getElementById('progress').classList.contains('on'),
      text: document.getElementById('progText').textContent,
      sub: document.getElementById('progSub').textContent,
      pages: document.querySelectorAll('#track .page').length,
      empty: document.getElementById('empty').classList.contains('show')
    })`);
    const line = `${s.text} ${s.sub} | 已渲染 ${s.pages}`;
    if (line !== last) { console.log(`    ${line}`); last = line; }
    if (!s.prog && s.pages > 0) return s.pages;
    if (s.empty) return -1;
  }
  return -2;
}

/**
 * 等 PDF 懒渲染全部完成（pendingPages 归 0）。
 * 阅读器现在是"秒开门 + 后台补页"，完整性断言要等全书就绪再做。
 */
async function waitAllRendered(timeoutSec = 300) {
  const t0 = Date.now();
  let last = -1;
  while (Date.now() - t0 < timeoutSec * 1000) {
    await sleep(2000);
    const st = await evalJson(`JSON.stringify(window.gushiReader.state())`);
    if (st.pendingPages !== last) {
      console.log(`    后台渲染中… 剩余 ${st.pendingPages} 页`);
      last = st.pendingPages;
    }
    if (st.pendingPages === 0) return st.total;
  }
  return -1;
}

/* =====================================================================
   A. 底色主题（需求 1）
   ===================================================================== */
console.log("\n右翻书古籍阅读器 · 交互测试");
console.log("=".repeat(58));
console.log("\nA. 阅读底色");

// 清掉上次运行留下的底色记录，保证"首次访问"这一断言是干净的
await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html` });
await sleep(2000);
await evalJs(`(function(){ try{ localStorage.removeItem('gushi-reader-theme'); }catch(e){} return true; })()`);
await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html` });
await sleep(2500);

// 面板默认收起，点按钮后展开；恰好 5 项
const themeInit = await evalJson(`JSON.stringify({
  panelOpen: document.getElementById('themePanel').classList.contains('open'),
  n: document.querySelectorAll('#themeList .tp-item').length,
  cur: document.body.getAttribute('data-theme'),
  listOpenAfterClick: null
})`);
check(themeInit.n === 5, `面板内有 5 个配色选项（实际 ${themeInit.n}）`);
check(themeInit.cur === "paper", `首次访问（无历史记录）默认「宣纸」（实际 ${themeInit.cur}）`);
check(themeInit.panelOpen === false, "配色面板默认收起");

const panelAfterClick = await evalJs(`(function(){
  document.getElementById('btnTheme').click();
  return document.getElementById('themePanel').classList.contains('open');
})()`);
check(panelAfterClick === true, "点击「底色」按钮展开配色面板");

// 逐个切换五个主题，验证 body[data-theme] 与选中态都跟着变
const themeIds = ["green", "amber", "slate", "sepia-dark", "paper"];
const switchResults = [];
for (const id of themeIds) {
  const r = await evalJs(`(function(){
    var el = document.querySelector('#themeList .tp-item[data-theme="${id}"]');
    if (!el) return 'missing';
    el.click();
    return document.body.getAttribute('data-theme') + '|' +
           (document.querySelector('#themeList .tp-item.cur') || {dataset:{}}).dataset.theme + '|' +
           document.getElementById('themePanel').classList.contains('open');
  })()`);
  switchResults.push(`${id}:${r}`);
}
check(
  switchResults.every((s) => { const id = s.split(":")[0]; return s === `${id}:${id}|${id}|false`; }),
  `五种配色切换均生效且自动收起面板（${switchResults.join("  ")}）`
);

// 实际生效的背景色要真的有区别
const bgColors = await evalJson(`(function(){
  function bg(id){
    document.querySelector('#themeList .tp-item[data-theme="'+id+'"]').click();
    return getComputedStyle(document.body).backgroundColor;
  }
  var r = {};
  ['paper','green','amber','slate','sepia-dark'].forEach(function(id){ r[id] = bg(id); });
  return JSON.stringify(r);
})()`);
const distinct = new Set(Object.values(bgColors));
check(distinct.size === 5, `五套底色的实际背景色互不相同（${Object.entries(bgColors).map(([k, v]) => k + "=" + v).join(" ")}）`);
// 深褐是暗色：亮度应明显低于宣纸
const lum = (c) => {
  const m = c.match(/\d+/g).map(Number);
  return 0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2];
};
check(
  lum(bgColors["sepia-dark"]) < lum(bgColors["paper"]) - 80,
  `「深褐」确为暗色主题（亮度 ${lum(bgColors["sepia-dark"]).toFixed(0)} vs 宣纸 ${lum(bgColors["paper"]).toFixed(0)}）`
);

// 记忆：切换后重新加载，应沿用上次选择
await evalJs(`document.querySelector('#themeList .tp-item[data-theme="green"]').click(); true`);
await goto(`http://127.0.0.1:${PORT}/index.html`);
const remembered = await evalJs(`document.body.getAttribute('data-theme')`);
check(remembered === "green", `重开页面沿用上次底色「豆沙绿」（实际 ${remembered}）`);

// T 快捷键循环
const keyCycled = await evalJs(`(function(){
  document.querySelector('#themeList .tp-item[data-theme="paper"]').click();
  var before = document.body.getAttribute('data-theme');
  window.dispatchEvent(new KeyboardEvent('keydown', { key:'t', bubbles:true }));
  var after = document.body.getAttribute('data-theme');
  return before + '->' + after;
})()`);
check(
  keyCycled === "paper->green",
  `T 键循环切换底色（${keyCycled}）`
);

// 点击面板外部关闭
const outsideClose = await evalJs(`(function(){
  document.getElementById('btnTheme').click();
  var open1 = document.getElementById('themePanel').classList.contains('open');
  document.getElementById('stage').click();
  var open2 = document.getElementById('themePanel').classList.contains('open');
  return open1 + ',' + open2;
})()`);
check(outsideClose === "true,false", `点击面板外部自动收起（${outsideClose}）`);

/* =====================================================================
   B. 大 PDF：超过 59 页不再空白（需求 2）
   ===================================================================== */
console.log("\nB. 大 PDF（> 59 页）载入");

if (!BIG_PDF) {
  check(false, "找到大页数测试 PDF（先运行 python tools/make_big_pdf.py 80）");
} else {
  console.log(`  测试文件: ${path.basename(BIG_PDF)}`);

  await goto(`http://127.0.0.1:${PORT}/index.html`);
  const tOpen0 = Date.now();
  const dropOk = await dropFile(BIG_PDF, path.basename(BIG_PDF), "application/pdf");
  check(dropOk === "ok", `成功拖入大 PDF（${dropOk}）`);

  const rendered = await waitReady(120);
  const openMs = Date.now() - tOpen0;
  check(rendered > 59, `秒级开门，页数超过 59（实际 ${rendered}，用时 ${(openMs / 1000).toFixed(1)}s）`);
  const totalPdfPages = Number(path.basename(BIG_PDF).match(/(\d+)/)?.[1] || 0) || 80;
  if (rendered > 0) {
    check(
      rendered === totalPdfPages,
      `解析出全部 ${totalPdfPages} 页，无遗漏（实际 ${rendered}）`
    );
  }

  // 懒渲染：等后台把全书补齐再做完整性断言
  const allDone = await waitAllRendered(300);
  check(allDone === totalPdfPages, `后台渲染补齐全书（剩余 0 页，共 ${allDone} 页）`);

  // 逐页检查 DOM 里每一项真的有图、并且图确实加载成功（不是破图/空白）
  const integrity = await evalJson(`JSON.stringify({
    pages: document.querySelectorAll('#track .page').length,
    imgs: document.querySelectorAll('#track .page img').length,
    broken: Array.from(document.querySelectorAll('#track .page img')).filter(function(im){
      return !im.complete || im.naturalWidth === 0;
    }).length,
    label: document.getElementById('pageLabel').innerText.replace(/\\s/g,''),
    blobCount: Array.from(document.querySelectorAll('#track .page img')).filter(function(im){
      return (im.getAttribute('src')||'').indexOf('blob:') === 0;
    }).length
  })`);
  console.log(`    页面数 ${integrity.pages}，图片数 ${integrity.imgs}，破图 ${integrity.broken}，页码 ${integrity.label}`);
  check(integrity.imgs === integrity.pages, "每一页都挂上了图片元素");
  check(integrity.broken === 0, `没有破图（naturalWidth>0 的图片数 = 全部，破图 ${integrity.broken} 张）`);
  check(integrity.blobCount === integrity.pages, "全部页面来自本机 blob（未上传服务器）");
  check(
    integrity.label === `${1}/${rendered}`,
    `从第 1 页开始，页码 1/${rendered}（实际 ${integrity.label}）`
  );

  // 跳到末页，确认末页也有真实内容。
  // 用页标（而不是几何位置）判断当前页，几何判断会受到轨道过渡动画影响。
  await evalJs(`window.goTo(${rendered - 1}, false); true`);
  await sleep(400);
  const lastCheck = await evalJson(`JSON.stringify({
    label: document.getElementById('pageLabel').innerText.replace(/\\s/g,''),
    cur: (function(){
      var cur = null;
      document.querySelectorAll('#track .page').forEach(function(el){
        if (el.querySelector('.pnum').textContent === '第 ${rendered} 页') cur = el;
      });
      if (!cur) return null;
      var im = cur.querySelector('img');
      return { src: cur.getAttribute('data-src'), cap: cur.querySelector('.pnum').textContent,
               ok: !!im && im.complete && im.naturalWidth > 0, w: im ? im.naturalWidth : 0 };
    })()
  })`);
  check(lastCheck.label === `${rendered}/${rendered}`, `可跳到末页（页码 ${lastCheck.label}）`);
  if (lastCheck.cur) {
    console.log(`    末页: ${lastCheck.cur.cap} (src=${lastCheck.cur.src}, ${lastCheck.cur.w}px 宽, 正常=${lastCheck.cur.ok})`);
    check(lastCheck.cur.ok === true, "末页图片真实渲染（naturalWidth > 0）");
    check(lastCheck.cur.w >= 1000, `末页保留高分辨率（${lastCheck.cur.w}px）`);
  } else {
    check(false, "能在 DOM 中定位到末页");
  }

  /* ===================================================================
     C. 「上一页」确实是上一页（需求 3）
     =================================================================== */
  console.log("\nC. 翻页语义");

  await evalJs(`window.goTo(3, false); true`);   // 停在第 4 页
  const seq = await evalJs(`(function(){
    var L = function(){ return document.getElementById('pageLabel').innerText.replace(/\\s/g,''); };
    var s = [L()];
    document.getElementById('btnNext').click(); s.push(L());
    document.getElementById('btnNext').click(); s.push(L());
    document.getElementById('btnPrev').click(); s.push(L());
    document.getElementById('btnPrev').click(); s.push(L());
    return s.join(' ');
  })()`);
  check(
    seq === "4/80 5/80 6/80 5/80 4/80",
    `右侧按钮=下一页、左侧按钮=上一页（第4页起 ${seq}）`
  );

  // 键盘 ← → 语义固定
  await evalJs(`window.goTo(9, false); true`);
  const keys = await evalJs(`(function(){
    var L = function(){ return document.getElementById('pageLabel').innerText.replace(/\\s/g,''); };
    var s = [L()];
    window.dispatchEvent(new KeyboardEvent('keydown', { key:'ArrowRight', bubbles:true })); s.push(L());
    window.dispatchEvent(new KeyboardEvent('keydown', { key:'ArrowRight', bubbles:true })); s.push(L());
    window.dispatchEvent(new KeyboardEvent('keydown', { key:'ArrowLeft',  bubbles:true })); s.push(L());
    return s.join(' ');
  })()`);
  check(
    keys === "10/80 11/80 12/80 11/80",
    `键盘 → 下一页、← 上一页（${keys}）`
  );

  // 第 1 页时「上一页」按钮禁用，说明它不会越界滚动
  await evalJs(`window.goTo(0, false); true`);
  const bounds = await evalJson(`JSON.stringify({
    prevDis: document.getElementById('btnPrev').disabled,
    nextDis: document.getElementById('btnNext').disabled,
    label: document.getElementById('pageLabel').innerText.replace(/\\s/g,'')
  })`);
  check(bounds.prevDis === true && bounds.nextDis === false,
    `第 1 页时「上一页」禁用、「下一页」可用（${bounds.label}）`);

  /* ===================================================================
     D. 「左开本」确实是第 1 页在最左（需求 4）
     =================================================================== */
  console.log("\nD. 装帧方向");

  // 切到左开本后，DOM 首个格子应是第 1 页
  const ltr = await evalJson(`(function(){
    document.getElementById('dirLTR').click();
    var els = document.querySelectorAll('#track .page');
    return JSON.stringify({
      firstSrc: els[0].getAttribute('data-src'),
      firstCap: els[0].querySelector('.pnum').textContent,
      lastCap: els[els.length-1].querySelector('.pnum').textContent,
      rtlPressed: document.getElementById('dirRTL').getAttribute('aria-pressed'),
      ltrPressed: document.getElementById('dirLTR').getAttribute('aria-pressed'),
      hint: document.getElementById('dirHint').textContent,
      isLeftOfStage: els[0].getBoundingClientRect().left <
                     els[els.length-1].getBoundingClientRect().left
    });
  })()`);
  check(ltr.firstSrc === "0", `左开本：DOM 首格是第 1 页（data-src=${ltr.firstSrc}）`);
  check(ltr.firstCap === "第 1 页", `左开本：首格页标为「第 1 页」（实际 ${ltr.firstCap}）`);
  check(ltr.lastCap === "第 80 页", `左开本：末格页标为「第 80 页」（实际 ${ltr.lastCap}）`);
  check(ltr.isLeftOfStage === true, "左开本：第 1 页确实位于屏幕左侧");
  check(ltr.ltrPressed === "true" && ltr.rtlPressed === "false", "顶栏切到「左开本」选中态");
  check(/左开本\s*·\s*第1页在左/.test(ltr.hint), `底栏提示「左开本 · 第1页在左」（实际「${ltr.hint}」）`);

  // 切回右开本：DOM 首格应是末页，末格是第 1 页
  const rtl = await evalJson(`(function(){
    document.getElementById('dirRTL').click();
    var els = document.querySelectorAll('#track .page');
    return JSON.stringify({
      firstSrc: els[0].getAttribute('data-src'),
      firstCap: els[0].querySelector('.pnum').textContent,
      lastSrc: els[els.length-1].getAttribute('data-src'),
      lastCap: els[els.length-1].querySelector('.pnum').textContent,
      n: els.length
    });
  })()`);
  check(rtl.firstCap === `第 ${rtl.n} 页`, `右开本：DOM 首格是末页「第 ${rtl.n} 页」（实际 ${rtl.firstCap}）`);
  check(rtl.lastSrc === "0" && rtl.lastCap === "第 1 页", `右开本：DOM 末格是第 1 页（实际 ${rtl.lastCap}）`);

  // 关键回归：切方向不应该把当前页也换掉
  const keepPage = await evalJs(`(function(){
    window.goTo(20, false);
    var before = document.getElementById('pageLabel').innerText.replace(/\\s/g,'');
    document.getElementById('dirLTR').click();
    var after1 = document.getElementById('pageLabel').innerText.replace(/\\s/g,'');
    document.getElementById('dirRTL').click();
    var after2 = document.getElementById('pageLabel').innerText.replace(/\\s/g,'');
    return before + ' ' + after1 + ' ' + after2;
  })()`);
  check(keepPage === "21/80 21/80 21/80", `切换装帧方向不改变当前页码（${keepPage}）`);

  // 左开本下，按钮语义同样不能反转
  const ltrNav = await evalJs(`(function(){
    document.getElementById('dirLTR').click();
    window.goTo(5, false);
    var L = function(){ return document.getElementById('pageLabel').innerText.replace(/\\s/g,''); };
    var s = [L()];
    document.getElementById('btnNext').click(); s.push(L());
    document.getElementById('btnPrev').click(); s.push(L());
    document.getElementById('btnPrev').click(); s.push(L());
    return s.join(' ');
  })()`);
  check(ltrNav === "6/80 7/80 6/80 5/80", `左开本下按钮语义不变（${ltrNav}）`);

  /* ===================================================================
     E. 缩放模式下滚动条从右向左（用户第 5 项反馈）
     =================================================================== */
  console.log("\nE. 滚动方向");

  // 切回右开本并放大，进入可滚动模式
  await evalJs(`document.getElementById('dirRTL').click(); true`);
  await sleep(300);
  // 放大前先回到第 1 页。
  // 放大是「停在原来那一页」的（刻意的：不能因为放大就把人拽回开头），
  // 上面的按钮测试结束时停在第 5 页，若直接放大，起点当然不会是第 1 页。
  // 想让下面"起点在最右端 + 显示第 1 页"这两条断言有意义，前提就得先在第 1 页。
  await evalJs(`window.goTo(0, false); true`);
  await sleep(300);
  await evalJs(`(function(){
    ['btnIn','btnIn','btnIn'].forEach(function(){ document.getElementById('btnIn').click(); });
    return true;
  })()`);
  await sleep(900);

  const zoomState = await evalJson(`JSON.stringify(window.gushiReader.state())`);
  check(zoomState.zoomed === true, `放大后进入可滚动模式（zoom=${zoomState.zoom.toFixed(2)}）`);
  check(zoomState.maxScroll > 0, `内容确实溢出，可滚动（maxScroll=${zoomState.maxScroll}px）`);

  // 关键断言 1：滚动条起点在最右端，且此刻显示第 1 页
  check(
    Math.abs(zoomState.scrollLeft - zoomState.maxScroll) <= 40,
    `右开本：滚动条起点在最右端（scrollLeft=${zoomState.scrollLeft}, max=${zoomState.maxScroll}）`
  );

  const startPage = await evalJs(`(function(){
    return window.gushiReader.state().idx + 1;
  })()`);
  check(startPage === 1, `右开本：起点显示第 1 页（实际第 ${startPage} 页）`);

  // 关键断言 2：把滚动条从右端往左拖，页码必须递增、且不跳页。
  // 采样步长要细于「一页的宽度」，否则会跨页取样、误判为跳页。
  const sweep = await evalJson(`(function(){
    var stage = document.getElementById('stage');
    var s = window.gushiReader.state();
    var pageW = (stage.scrollWidth - 44) / s.total;
    var STEPS = Math.max(60, Math.ceil(s.maxScroll / (pageW / 3)));
    var seen = [];
    for (var f = 0; f <= STEPS; f++){
      stage.scrollLeft = Math.round(s.maxScroll * (1 - f/STEPS));
      var sr = stage.getBoundingClientRect();
      var best = null, bestArea = -1;
      document.querySelectorAll('#track .page').forEach(function(el){
        var b = el.getBoundingClientRect();
        var w = Math.min(b.right, sr.right) - Math.max(b.left, sr.left);
        var h = Math.min(b.bottom, sr.bottom) - Math.max(b.top, sr.top);
        var area = Math.max(0, w) * Math.max(0, h);
        if (area > bestArea){ bestArea = area; best = Number(el.dataset.src) + 1; }
      });
      if (seen[seen.length-1] !== best) seen.push(best);
    }
    stage.scrollLeft = s.maxScroll;
    return JSON.stringify(seen);
  })()`);
  console.log(`    从右端往左拖，依次看到: 第 ${sweep.join(" → 第 ")} 页`);

  check(sweep[0] === 1, `拖动起点是第 1 页（实际第 ${sweep[0]} 页）`);
  check(sweep[sweep.length - 1] === rendered, `拖到最左端是末页（实际第 ${sweep[sweep.length-1]} 页）`);
  // 单调递增：页码只能一页页往后，不能回跳
  const monotonic = sweep.every((v, i) => i === 0 || v > sweep[i-1]);
  check(monotonic, `页码单调递增，不回头（共 ${sweep.length} 个采样点）`);
  // 相邻采样之间不应跨越超过 2 页（跨太多说明映射有断层）
  const maxJump = Math.max(...sweep.map((v, i) => i === 0 ? 0 : v - sweep[i-1]));
  check(maxJump <= 2, `相邻采样最多跨 ${maxJump} 页，无整段跳过`);
  check(
    sweep.length === rendered,
    `拖动过程中恰好依次经过全部 ${rendered} 页（实际经过 ${sweep.length} 页）`
  );

  // 关键断言 3：相反方向拖动，页码应该递减
  const back = await evalJson(`(function(){
    var stage = document.getElementById('stage');
    var s = window.gushiReader.state();
    var seen = [];
    var STEPS = 10;
    for (var f = 0; f <= STEPS; f++){
      stage.scrollLeft = Math.round(s.maxScroll * (f/STEPS));
      var sr = stage.getBoundingClientRect();
      var best = null, bestArea = -1;
      document.querySelectorAll('#track .page').forEach(function(el){
        var b = el.getBoundingClientRect();
        var w = Math.min(b.right, sr.right) - Math.max(b.left, sr.left);
        var h = Math.min(b.bottom, sr.bottom) - Math.max(b.top, sr.top);
        var area = Math.max(0, w) * Math.max(0, h);
        if (area > bestArea){ bestArea = area; best = Number(el.dataset.src) + 1; }
      });
      if (seen[seen.length-1] !== best) seen.push(best);
    }
    stage.scrollLeft = s.maxScroll;
    return JSON.stringify(seen);
  })()`);
  console.log(`    从左端往右拖（回退）: 第 ${back.join(" → 第 ")} 页`);
  check(
    back.every((v, i) => i === 0 || v <= back[i-1]),
    `反向拖动页码不增（${back.join(",")}）`
  );

  // 左开本对照：滚动条应从最左端起，往右拖才往后
  await evalJs(`document.getElementById('dirLTR').click(); true`);
  await sleep(500);
  const ltrScroll = await evalJson(`JSON.stringify(window.gushiReader.state())`);
  check(
    ltrScroll.scrollLeft <= 40,
    `左开本：滚动条起点回到最左端（scrollLeft=${ltrScroll.scrollLeft}）`
  );

  await evalJs(`document.getElementById('btnFit').click(); true`);
  await sleep(400);
  const fitState = await evalJson(`JSON.stringify(window.gushiReader.state())`);
  check(fitState.zoomed === false, "「适应窗口」可退出滚动模式");

  await evalJs(`document.getElementById('dirRTL').click(); true`);
  await sleep(300);
}

/* =====================================================================
   收尾
   ===================================================================== */
if (consoleErrors.length) {
  console.log(`\n  页面控制台异常 ${consoleErrors.length} 条:`);
  consoleErrors.slice(0, 5).forEach((e) => console.log("    - " + String(e).split("\n")[0].slice(0, 160)));
}

console.log("\n" + out.join("\n"));
console.log("=".repeat(58));
console.log(fails === 0 ? `全部通过（共 ${out.length} 项）` : `存在 ${fails} 项失败（共 ${out.length} 项）`);

ws.close();
chrome.kill();
server.close();
process.exit(fails === 0 ? 0 : 1);
