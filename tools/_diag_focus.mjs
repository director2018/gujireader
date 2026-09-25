// 一次性验证：聚焦功能（一页 / 两页两种范围）（自包含，套用 interact_check 的 CDP 模式）
// 1) 默认关闭，无 .focus-cur 标记
// 2) gushiReader.setFocus(true) 后只有当前页带 .focus-cur，body data-focus=1
// 3) 相邻页的计算样式确实有 blur
// 4) 翻页后清晰页跟着走
// 5) 范围切到两页：当前跨（src=2,3）两页都清晰
// 6) 翻到下一跨，两页标记跟着走（src=4,5）
// 7) 按钮点击：聚焦2页按钮再点关闭；聚焦1页按钮开启一页档
// 8) X 键循环：关 → 一页 → 两页 → 关
// 9) localStorage 持久化（开关 + 范围，重载后沿用）
import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PORT = 8861;
const PORT_CDP = 9581;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    let p = path.join(ROOT, decodeURIComponent(url.pathname));
    if (p.endsWith("/") || p.endsWith("\\")) p = path.join(p, "index.html");
    const data = await readFile(p);
    res.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404); res.end("404");
  }
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const CHROME = [
  "C:\\Users\\DELL\\.agent-browser\\browsers\\chrome-153.0.8010.47\\chrome.exe",
  "C:\\Users\\DELL\\.agent-browser\\browsers\\chrome-152.0.7977.64\\chrome.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((c) => existsSync(c));
if (!CHROME) { console.log("未找到浏览器"); server.close(); process.exit(2); }

const profile = path.join(ROOT, ".cdp-profile-focus");
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
async function evalJs(expr, awaitPromise = false) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "eval 出错");
  return r.result?.result?.value;
}
await send("Page.enable");
await send("Runtime.enable");

const out = [];
let fails = 0;
const check = (c, m) => { if (!c) fails++; out.push((c ? "  [通过] " : "  [失败] ") + m); };

await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html` });
// profile 可能残留上次运行的 localStorage（持久化恰好生效的证明），
// 清掉并重载，保证从"默认状态"开始验证
await sleep(1500);
await evalJs(`try{ localStorage.clear(); }catch(e){}; true`);
await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html` });
// 等书打开（磁盘模式 6 页）
let opened = false;
for (let i = 0; i < 30; i++) {
  await sleep(1000);
  const s = await evalJs(`(window.gushiReader ? window.gushiReader.state().total : 0)`);
  if (s > 0) { opened = true; break; }
}
check(opened, "磁盘模式书籍已打开");

// 1) 默认关闭
let st = await evalJs(`JSON.stringify((() => {
  const s = window.gushiReader.state();
  return {
    focus: s.focus,
    scope: s.focusScope,
    dataFocus: document.body.getAttribute("data-focus"),
    marked: document.querySelectorAll(".page.focus-cur").length,
  };
})())`).then(JSON.parse);
check(st.focus === false, `默认 focus=false（实际 ${st.focus}）`);
check(st.scope === "1", `默认范围为一页（实际 ${st.scope}）`);
check(st.dataFocus !== "1", "默认 body 无 data-focus=1");
check(st.marked === 0, "默认无 .focus-cur 标记");

// 2) 开启 + 只有当前页（第1页 src=0）被标记
await evalJs(`window.gushiReader.setFocus(true)`);
st = await evalJs(`JSON.stringify((() => {
  const s = window.gushiReader.state();
  const cur = [...document.querySelectorAll(".page.focus-cur")].map(e => e.dataset.src);
  return { focus: s.focus, scope: s.focusScope, dataFocus: document.body.getAttribute("data-focus"), cur };
})())`).then(JSON.parse);
check(st.focus === true, "setFocus(true) 后 focus=true");
check(st.scope === "1", "范围保持一页");
check(st.dataFocus === "1", "body data-focus=1");
check(st.cur.length === 1 && st.cur[0] === "0",
  `恰好只有当前页(第1页)被标记（实际 ${JSON.stringify(st.cur)}）`);

// 3) 相邻页真的被虚化了（计算样式 filter 含 blur），当前页没有
// 注意 .sheet 上有 0.3s 的 filter 过渡，刚开启瞬间采到的是 blur(0px)，
// 等过渡结束后再采样，验证的才是最终规则值
await sleep(600);
st = await evalJs(`JSON.stringify((() => {
  const cs = (el) => getComputedStyle(el.querySelector(".sheet")).filter;
  const cur = document.querySelector('.page.focus-cur');
  const other = document.querySelector('.page:not(.focus-cur)');
  return { curFilter: cs(cur), otherFilter: cs(other) };
})())`).then(JSON.parse);
check(!/blur\(/.test(st.curFilter), "当前页 sheet 无 blur（实际 " + st.curFilter + "）");
check(/blur\(/.test(st.otherFilter), "相邻页 sheet 有 blur（实际 " + st.otherFilter + "）");

// 4) 翻页跟随
await evalJs(`window.goTo(2, false)`);
await sleep(600); // 等 updateChrome / 动画
st = await evalJs(`JSON.stringify([...document.querySelectorAll(".page.focus-cur")].map(e => e.dataset.src))`).then(JSON.parse);
check(st.length === 1 && st[0] === "2", `翻到第3页后标记跟随到 src=2（实际 ${JSON.stringify(st)}）`);

// 5) 范围切到两页：当前跨（6 页单页书 → 配对跨 [2,3]）两页都清晰
await evalJs(`window.gushiReader.setFocusScope("2")`);
st = await evalJs(`JSON.stringify((() => {
  const s = window.gushiReader.state();
  const cur = [...document.querySelectorAll(".page.focus-cur")].map(e => e.dataset.src);
  return { focus: s.focus, scope: s.focusScope, cur,
    p1: document.getElementById("btnFocus").getAttribute("aria-pressed"),
    p2: document.getElementById("btnFocus2").getAttribute("aria-pressed") };
})())`).then(JSON.parse);
check(st.focus === true && st.scope === "2", "setFocusScope(2) 后范围=两页");
check(st.cur.length === 2 && st.cur.includes("2") && st.cur.includes("3"),
  `当前跨两页(src=2,3)都被标记（实际 ${JSON.stringify(st.cur)}）`);
check(st.p1 === "false" && st.p2 === "true", "按钮高亮：聚焦1页灭、聚焦2页亮");

// 6) 翻到下一跨，两页标记跟着走
await evalJs(`window.goTo(4, false)`);
await sleep(600);
st = await evalJs(`JSON.stringify([...document.querySelectorAll(".page.focus-cur")].map(e => e.dataset.src))`).then(JSON.parse);
check(st.length === 2 && st.includes("4") && st.includes("5"),
  `翻到第5页后标记跟随到 src=4,5（实际 ${JSON.stringify(st)}）`);

// 7) 按钮点击：聚焦2页按钮再点=关闭；聚焦1页按钮=开一页档
await evalJs(`document.getElementById("btnFocus2").click()`);
st = await evalJs(`JSON.stringify({
  focus: window.gushiReader.state().focus,
  marked: document.querySelectorAll(".page.focus-cur").length,
  p1: document.getElementById("btnFocus").getAttribute("aria-pressed"),
  p2: document.getElementById("btnFocus2").getAttribute("aria-pressed"),
})`).then(JSON.parse);
check(st.focus === false, "聚焦2页按钮再点关闭聚焦");
check(st.p1 === "false" && st.p2 === "false", "两个按钮高亮都熄灭");
check(st.marked === 0, "关闭后清除全部标记");
await evalJs(`document.getElementById("btnFocus").click()`);
st = await evalJs(`JSON.stringify({
  s: window.gushiReader.state(),
  marked: [...document.querySelectorAll(".page.focus-cur")].map(e => e.dataset.src),
  p1: document.getElementById("btnFocus").getAttribute("aria-pressed"),
})`).then(JSON.parse);
check(st.s.focus === true && st.s.focusScope === "1", "聚焦1页按钮开启一页档");
check(st.marked.length === 1 && st.marked[0] === "4", `一页档只标记当前页 src=4（实际 ${JSON.stringify(st.marked)}）`);
check(st.p1 === "true", "聚焦1页按钮高亮");

// 8) X 键循环：关 → 一页 → 两页 → 关
await evalJs(`document.getElementById("btnFocus").click()`); // 先关掉
const pressX = `(() => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true }));
  return JSON.stringify(window.gushiReader.state());
})()`;
st = await evalJs(pressX).then(JSON.parse);
check(st.focus === true && st.focusScope === "1", "X 第1次：开一页档");
st = await evalJs(pressX).then(JSON.parse);
check(st.focus === true && st.focusScope === "2", "X 第2次：切两页档");
st = await evalJs(pressX).then(JSON.parse);
check(st.focus === false, "X 第3次：关闭");

// 9) localStorage 持久化（含重载恢复）
await evalJs(`window.gushiReader.setFocusScope("2")`); // 开两页档
st = await evalJs(`localStorage.getItem("gushi-reader-focus")`);
check(st === "1", `localStorage 开关记录为 1（实际 ${st}）`);
st = await evalJs(`localStorage.getItem("gushi-reader-focus-scope")`);
check(st === "2", `localStorage 范围记录为 2（实际 ${st}）`);
await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html` });
await sleep(2000);
st = await evalJs(`JSON.stringify(window.gushiReader.state())`).then(JSON.parse);
check(st.focus === true && st.focusScope === "2", "重载后沿用「两页聚焦」");

console.log("\n右翻书古籍阅读器 · 聚焦（一页 / 两页）验证");
console.log("=".repeat(40));
out.forEach((l) => console.log(l));
console.log("-".repeat(40));
console.log(`全部通过（共 ${out.length} 项）` + (fails ? `，失败 ${fails} 项！` : ""));
chrome.kill();
server.close();
process.exit(fails ? 1 : 0);
