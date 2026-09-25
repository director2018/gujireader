// 诊断：开发者签名彩蛋
//   1) 连续键入 "liweiyuan" 应弹出全屏签名浮层（含印章）；
//   2) 浮层约 3 秒后自动消失；
//   3) 序列被错误按键打断后重新输全仍可触发；
//   4) 全程无 JS 报错、无对话框。
import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PORT = 8869;
const PORT_CDP = 9589;

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

const profile = path.join(ROOT, ".cdp-profile-egg");
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

await send("Page.enable");
await send("Runtime.enable");

const out = [];
let fails = 0;
const check = (c, m) => { if (!c) fails++; out.push((c ? "  [通过] " : "  [失败] ") + m); };

await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html` });
await sleep(3000);

async function typeSeq(seq) {
  for (const ch of seq) {
    await evalJs(`window.dispatchEvent(new KeyboardEvent("keydown",{key:${JSON.stringify(ch)}}))`);
    await sleep(30);
  }
}

// 1) 正确序列触发
await typeSeq("liweiyuan");
await sleep(400);
let st = await evalJs(`(function(){
  const ovs=[...document.querySelectorAll("body > div")].filter(d=>d.style.zIndex==="9999");
  if(!ovs.length) return {ok:false};
  const t=ovs[0].textContent||"";
  return {ok:true, hasDev:t.includes("liweiyuan"), hasTitle:t.includes("右翻书古籍阅读器")};
})()`);
check(st && st.ok, "键入 liweiyuan 弹出全屏签名浮层");
check(st && st.hasDev, "浮层含作者署名 liweiyuan");
check(st && st.hasTitle, "浮层含作品名");

// 2) 自动消失
await sleep(3400);
let gone = await evalJs(`[...document.querySelectorAll("body > div")].every(d=>d.style.zIndex!=="9999")`);
check(gone, "浮层约 3 秒后自动消失");

// 3) 错误打断后重输仍可触发
await typeSeq("liweix");
await typeSeq("yuan");
await sleep(300);
let notYet = await evalJs(`[...document.querySelectorAll("body > div")].every(d=>d.style.zIndex!=="9999")`);
check(notYet, "被打断的序列不触发");
await typeSeq("liweiyuan");
await sleep(400);
let again = await evalJs(`[...document.querySelectorAll("body > div")].some(d=>d.style.zIndex==="9999" && (d.textContent||"").includes("liweiyuan"))`);
check(again, "重新输全序列再次触发");
await sleep(3400);

// 4) 干扰项：单独无关字母不触发
await typeSeq("www");
await sleep(300);
let noTrip = await evalJs(`[...document.querySelectorAll("body > div")].every(d=>d.style.zIndex!=="9999")`);
check(noTrip, "无关按键不触发彩蛋");

check(errs.length === 0, `无 JS 报错${errs.length ? "：" + errs[0] : ""}`);
check(dialogs.length === 0, "无意外对话框");

console.log(out.join("\n"));
console.log("========================================================");
console.log(fails === 0 ? `全部通过（共 ${out.length} 项）` : `存在 ${fails} 项失败`);

ws.close();
chrome.kill();
await sleep(500);
try { await (await import("node:fs/promises")).rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 800 }); } catch {}
server.close();
process.exit(fails === 0 ? 0 : 1);
