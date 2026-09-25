// 一次性验证：翻书模式（自包含 CDP）
// 核心模型：一屏摊开一「跨」，像一本摊在桌上的书；任何一页都是完整原页。
//   宽高比 >= 1.15 的源图（一页里印着左右两面书）整张居中独占一屏；
//   单页扫描两两配跨：右开本先读页在右、次读页在左（左开本反之）。
// 场景：
//   书 A：4 张单页（400x600）            -> 2 跨，跨内左右各一页
//   书 C：1 张单页（400x600）            -> 1 跨，整张居中，翻不动
//   书 B：单页 / 对开 / 单页 / 单页 / 单页 -> 4 跨（single / full / pair / single）
// 验证：
//   1) 跨划分与页序：一次翻页 = 一跨，跨内页序永远跟随源文件
//   2) 摆位：配对跨左右纸各自贴书脊；对开图中线落书脊、绝不裁切
//   3) 动画：翻动层贴书脊、转轴与角度正确；对开页走淡换
//   4) 方向语义、左开本镜像
//   5) 持久化 / boot 恢复 / 缩放拦截 / 切回连续模式
import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PORT = 8864;
const PORT_CDP = 9584;

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

const profile = path.join(ROOT, ".cdp-profile-book");
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

/** 页面内用 canvas 造图并一次 drop 导入成一本书 */
async function dropImages(spec) {
  await evalJs(`(function(){
    window.__dropDone = "pending";
    var spec = ${JSON.stringify(spec)};
    function mk(w, h, color, name){
      return new Promise(function(res){
        var c = document.createElement("canvas"); c.width = w; c.height = h;
        var x = c.getContext("2d");
        x.fillStyle = color; x.fillRect(0, 0, w, h);
        x.fillStyle = "#222"; x.font = "bold 48px serif";
        x.fillText(name, 20, 80);
        c.toBlob(function(b){ res(new File([b], name, { type:"image/png" })); }, "image/png");
      });
    }
    Promise.all(spec.map(function(s){ return mk(s[0], s[1], s[2], s[3]); })).then(function(files){
      var dt = new DataTransfer();
      files.forEach(function(f){ dt.items.add(f); });
      window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles:true, cancelable:true }));
      window.__dropDone = "ok";
    }).catch(function(e){ window.__dropDone = "err: " + e.message; });
    return true;
  })()`);
  for (let i = 0; i < 24; i++) {
    if (await evalJs(`window.__dropDone`) !== "pending") break;
    await sleep(500);
  }
  return evalJs(`window.__dropDone`);
}

/** 等一本书就绪（页数对上且图片都出图） */
async function waitBook(total) {
  let st = null;
  for (let i = 0; i < 24; i++) {
    await sleep(500);
    st = JSON.parse(await evalJs(`JSON.stringify(gushiReader.state())`));
    if (st.total === total && st.pendingPages === 0) return st;
  }
  return st;
}

/** 等待翻页动画走完（flipBusy 归位且 idx 到位） */
async function waitFlip(targetIdx) {
  for (let i = 0; i < 24; i++) {
    await sleep(250);
    const st = JSON.parse(await evalJs(`JSON.stringify(gushiReader.state())`));
    if (!st.flipping && st.idx === targetIdx) return true;
  }
  return false;
}
const stateOf = async () => JSON.parse(await evalJs(`JSON.stringify(gushiReader.state())`));
const bookOf = async () => JSON.parse(await evalJs(`JSON.stringify(gushiReader.bookInfo())`));

await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html` });
for (let i = 0; i < 30; i++) {
  await sleep(1000);
  const s = await evalJs(`(window.gushiReader ? window.gushiReader.state().total : 0)`).catch(() => 0);
  if (s > 0) break;
}
// 复用的浏览器 profile 会残留上一次的 localStorage（含 view/book），
// 先清干净再重进一次，保证测的是「默认态」
await evalJs(`try{ localStorage.clear(); }catch(e){} true`);
await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html` });
await sleep(2000);
await evalJs(`clearHistory()`);

/* ================= 书 A：4 张单页 —— 两两配跨，左右各一页 ================= */
let st = await stateOf();
check(st.view === "scroll", `初始为连续模式（view=${st.view}）`);

const dropA = await dropImages([
  [400, 600, "#f5efe0", "01-a.png"],
  [400, 600, "#efe6f5", "02-b.png"],
  [400, 600, "#e6f5ee", "03-c.png"],
  [400, 600, "#f5e6e6", "04-d.png"],
]);
check(dropA === "ok", `4 张单页拖入成功（实际 ${dropA}）`);
st = await waitBook(4);
check(st.total === 4, `开书成功、共 4 页（实际 ${st.total}）`);

await evalJs(`gushiReader.setView("book")`);
await sleep(400);
st = await stateOf();
check(st.view === "book", `setView("book") 后 view=book`);
// 默认方向已改为左开本（向右翻）；本段先显式切到右开本，验证右开路径
await evalJs(`gushiReader.setDirection("right-to-left")`);
await sleep(300);
check(await evalJs(`document.body.dataset.view`) === "book", "body[data-view=book] 已挂上");
check(await evalJs(`getComputedStyle(document.getElementById("book")).display`) === "flex", "翻书层可见");
check(await evalJs(`getComputedStyle(document.getElementById("track")).visibility`) === "hidden", "连续轨道已隐藏");

// --- 一屏一跨：第 1 跨右 1 左 2 ---
let info = await bookOf();
check(info.total === 4 && info.index === 0, `当前第 1 页 / 共 4 页（index=${info.index}, total=${info.total}）`);
check(info.crossCount === 2 && info.crossKind === "pair", `4 页单页扫描配成 2 跨（crossCount=${info.crossCount}, kind=${info.crossKind}）`);
check(info.right && info.right.idx === 0 && Math.abs(info.right.left - info.spineX) <= 4,
  `右开本先读页在右、装订缘贴书脊（left=${info.right && info.right.left}, spineX=${info.spineX}）`);
check(info.left && info.left.idx === 1 && Math.abs((info.left.left + info.left.w) - info.spineX) <= 4,
  `次读页在左、装订缘贴书脊（右缘=${info.left && info.left.left + info.left.w}）`);
check(await evalJs(`!!document.querySelector("#bookR img") && document.querySelector("#bookR img").src.length > 0`),
  "右侧纸已出图（#bookR img.src 非空）");
let num = await evalJs(`document.getElementById("bookNum").textContent`);
check(num.includes("1–2") && num.includes("共 4 页"), `页码标签报出跨内范围（实际「${num}」）`);
check(await evalJs(`document.getElementById("bookGutter").className`) === "g-spread",
  "书脊阴影压在正中（g-spread）");

// --- 翻页：一次翻一跨（跨内两页一起换） ---
await evalJs(`next()`);
await sleep(160);
st = await stateOf();
check(st.flipping === true, "翻页动画进行中（flipping=true）");
const flip = JSON.parse(await evalJs(`JSON.stringify((function(){
  var w = document.getElementById("bookFlipWrap");
  var f = w.querySelector(".flip");
  return {
    left: Math.round(parseFloat(w.style.left) || 0),
    width: Math.round(parseFloat(w.style.width) || 0),
    origin: f.style.transformOrigin,
    transform: f.style.transform,
  };
})())`));
check(Math.abs(flip.left - info.spineX) <= 4,
  `翻动的那张纸贴在书脊右侧（left=${flip.left}, spineX=${info.spineX}）`);
check(flip.origin === "0% 50%", `转轴落在书脊（transform-origin=${flip.origin}）`);
check(String(flip.transform).includes("-180deg"), `右开本绕书脊向左翻 180°（transform=${flip.transform}）`);

const ok1 = await waitFlip(2);
check(ok1, `一次翻一跨：跨内首页 idx 0 -> 2（idx=${(await stateOf()).idx}）`);
info = await bookOf();
check(info.cross === 1 && info.crossPages[0] === 2 && info.crossPages[1] === 3,
  `第 2 跨摊开第 3、4 页（${info.crossPages.map((i) => i + 1).join("、")}）`);
num = await evalJs(`document.getElementById("bookNum").textContent`);
check(num.includes("3–4"), `页码跟着换到第 3–4 页（实际「${num}」）`);

// --- 到末跨再往后 = 不动；往回翻回到第 1 跨 ---
await evalJs(`next()`);
await sleep(900);
check(await stateOf().then((s) => s.idx === 2), "已在末跨，再往后翻不动");
await evalJs(`prev()`);
check(await waitFlip(0), `往回翻回到第 1 跨（idx=${(await stateOf()).idx}）`);

// --- goTo 直达（滑块 / 缩略图走的无动画路径） ---
await evalJs(`goTo(0)`);
await sleep(300);
st = await stateOf();
check(st.idx === 0 && !st.flipping, `goTo(0) 直达且不触发动画（idx=${st.idx}）`);

// --- 末页再往后翻 = 回弹，不动 ---
await evalJs(`goTo(3)`);
await sleep(300);
await evalJs(`next()`);
await sleep(700);
st = await stateOf();
check(st.idx === 3 && !st.flipping, "末页再往后翻不会越界");

/* ================= 书 C：只有一页 —— 整张居中 ================= */
await evalJs(`goTo(0)`);
const dropC = await dropImages([[400, 600, "#f0f0e0", "01-solo.png"]]);
check(dropC === "ok", `单页书拖入成功（实际 ${dropC}）`);
st = await waitBook(1);
check(st.total === 1, `单页书开书成功（实际 ${st.total} 页）`);
await sleep(400);
info = await bookOf();
check(info.total === 1 && info.index === 0, `1 页的书就是 1 跨（index=${info.index}, total=${info.total}）`);
check(!!info.full && !info.left && !info.right, `唯一一页按整张居中摆（full 槽在用，左右槽空）`);
if (info.full) check(Math.abs((info.full.left + info.full.w / 2) - info.spineX) <= 2,
  `居中：整张中线落书脊（${Math.round(info.full.left + info.full.w / 2)} vs ${info.spineX}）`);
num = await evalJs(`document.getElementById("bookNum").textContent`);
check(num.includes("第 1 页"), `页码标签显示第 1 页（实际「${num}」）`);
await evalJs(`next()`);
await sleep(700);
st = await stateOf();
check(st.idx === 0 && !st.flipping, "只有一页时点下一页不会翻动");

/* ================= 书 B：单页 / 对开 / 单页 / 单页 / 单页 ================= */
const dropB = await dropImages([
  [400, 600, "#f5efe0", "01-cover.png"],
  [1200, 600, "#e8f0e4", "02-spread.png"],
  [400, 600, "#efe6f5", "03-p3.png"],
  [400, 600, "#e6f5ee", "04-p4.png"],
  [400, 600, "#f5e6e6", "05-p5.png"],
]);
check(dropB === "ok", `混合书拖入成功（实际 ${dropB}）`);
st = await waitBook(5);
check(st.total === 5, `混合书开书成功（实际 ${st.total} 页）`);
await sleep(400);
info = await bookOf();
check(info.index === 0 && info.kind === "single", "第 1 跨 = 封面单页（与对开页相邻，落单在先读侧）");
check(info.crossCount === 4, `5 页切成 4 跨：single / full / pair / single（${info.crossCount}）`);

// 对开扫描页：整张摊开、中线落在书脊、不拆成两页
await evalJs(`goTo(1)`);
await sleep(300);
info = await bookOf();
check(info.index === 1 && info.kind === "full", `第 2 页是对开扫描、整张摊开（kind=${info.kind}）`);
check(info.full && Math.abs(info.full.left + info.full.w / 2 - info.spineX) <= 2,
  `对开图宽中线落在书脊上（left+w/2=${info.full && Math.round(info.full.left + info.full.w / 2)}, spineX=${info.spineX}）`);
check(info.full && info.full.w > info.spineX, `对开图比单页宽得多（w=${info.full && info.full.w}）`);
check(await evalJs(`!!document.querySelector("#bookFull img") && document.querySelector("#bookFull img").src.length > 0`),
  "对开图已出图（#bookFull img.src 非空）");
check(await evalJs(`getComputedStyle(document.getElementById("bookR")).display`) === "none",
  "对开页不用左右半槽位（没被拆开）");
num = await evalJs(`document.getElementById("bookNum").textContent`);
check(num.includes("第 2 页"), `对开页页码显示第 2 页（实际「${num}」）`);

// 对开页参与翻页走淡换（整张纸横跨书脊，绕轴转会甩出画面）
await evalJs(`next()`);
await sleep(120);
const softOpacity = await evalJs(`document.getElementById("bookArea").style.opacity`);
check(softOpacity === "0", `对开页翻页走淡换（opacity=${softOpacity}）`);
check(await waitFlip(2), "从对开页翻到第 3 跨（idx=2）");
check(await evalJs(`document.getElementById("bookArea").style.opacity`) === "1", "淡换结束透明度恢复");
info = await bookOf();
check(info.crossKind === "pair" && info.crossPages[0] === 2 && info.crossPages[1] === 3,
  `对开页之后接回配对跨（${info.crossPages.map((i) => i + 1).join("、")}）`);

// 往回翻过对开页 / 翻回封面
await evalJs(`prev()`);
check(await waitFlip(1), "从第 3 页往回翻到对开页（idx=1）");
await evalJs(`prev()`);
check(await waitFlip(0), "从对开页往回翻到封面（idx=0）");

// 后面两张单页配成一跨，最后一张落单
await evalJs(`goTo(4)`);
await sleep(300);
info = await bookOf();
check(info.index === 4 && info.kind === "single" && info.half === "right", "末页落单，摆在先读侧（右）");

/* ================= 左开本镜像 ================= */
await evalJs(`goTo(0)`);
await sleep(200);
await evalJs(`gushiReader.setDirection("left-to-right")`);
await sleep(400);
info = await bookOf();
check(info.half === "left" && info.left && Math.abs((info.left.left + info.left.w) - info.spineX) <= 4,
  `左开本落单封面在书脊左侧、右缘贴书脊（half=${info.half}, 右缘=${info.left && info.left.left + info.left.w}）`);
check(await evalJs(`document.getElementById("bookGutter").className`) === "g-out",
  "左开本书脊阴影落在纸的右缘装订侧（g-out）");
// 左开本翻页：翻动层落在书脊左侧，转轴在书脊，方向相反（在配对跨上测）
await evalJs(`goTo(2)`);
await sleep(300);
await evalJs(`next()`);
await sleep(160);
const flipL = JSON.parse(await evalJs(`JSON.stringify((function(){
  var w = document.getElementById("bookFlipWrap");
  var f = w.querySelector(".flip");
  return { left: Math.round(parseFloat(w.style.left) || 0), origin: f.style.transformOrigin, transform: f.style.transform };
})())`));
check(flipL.origin === "100% 50%" && String(flipL.transform).includes("180deg"),
  `左开本翻动纸在书脊左侧、转轴贴书脊、正向掀起（origin=${flipL.origin}, transform=${flipL.transform}）`);
await waitFlip(4);
await evalJs(`gushiReader.setDirection("right-to-left")`);
await sleep(300);

/* ================= 持久化 / boot 恢复 / 缩放拦截 / 切回 ================= */
const saved = await evalJs(`localStorage.getItem("gushi-reader-view")`);
check(saved === "book", `模式已持久化（localStorage=${saved}）`);
await evalJs(`goTo(0)`);
await sleep(200);
await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html` });
await sleep(2500);
st = await stateOf();
check(st.view === "book", `刷新后自动回到翻书模式（view=${st.view}）`);
check(await evalJs(`getComputedStyle(document.getElementById("book")).display`) === "flex", "刷新后翻书层直接可见");

const zBefore = st.zoom;
await evalJs(`zoomBy(1.25)`);
st = await stateOf();
check(st.zoom === zBefore, `翻书模式下缩放被拦截（zoom 仍为 ${st.zoom}）`);

await evalJs(`gushiReader.setView("scroll")`);
await sleep(300);
st = await stateOf();
check(st.view === "scroll", "切回连续模式");
check(await evalJs(`getComputedStyle(document.getElementById("track")).visibility`) === "visible", "连续轨道恢复可见");
check(await evalJs(`localStorage.getItem("gushi-reader-view")`) === "scroll", "切回后持久化同步为 scroll");

console.log("\n右翻书古籍阅读器 · 翻书模式（一屏摊开一跨）验证");
console.log("=".repeat(48));
out.forEach((l) => console.log(l));
console.log("-".repeat(48));
console.log(`全部通过（共 ${out.length} 项）` + (fails ? `，失败 ${fails} 项！` : ""));
chrome.kill();
server.close();
process.exit(fails ? 1 : 0);
