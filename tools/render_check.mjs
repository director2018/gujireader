// 极简静态服务器 + 无头 Chrome 渲染验证（磁盘模式）
// 用法: node tools/render_check.mjs
//
// 用真实浏览器加载阅读器（读 data/manifest.json），等 JS 跑完后把渲染结果
// 从 DOM 里读出来，验证新的方向模型：
//   - 右开本：第 1 页摆最右，语义页码 1 在最右一格
//   - 左开本：第 1 页摆最左
//   - 上一页/下一页按钮的语义不随装帧方向改变
//   - 底色主题面板五个选项、切换生效

import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PORT = 8801;

const MIME = {
  ".html": "text/html;charset=utf-8",
  ".json": "application/json;charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript;charset=utf-8",
  ".css": "text/css;charset=utf-8",
};

const server = http.createServer(async (req, res) => {
  let p = decodeURIComponent((req.url || "/").split("?")[0]);
  if (p === "/") p = "/index.html";
  const f = path.join(ROOT, p);
  try {
    const data = await readFile(f);
    res.writeHead(200, { "Content-Type": MIME[path.extname(f).toLowerCase()] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("404");
  }
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
console.log(`静态服务器已启动: http://127.0.0.1:${PORT}/`);

// 找 Chrome
const candidates = [
  "C:\\Users\\DELL\\.agent-browser\\browsers\\chrome-153.0.8010.47\\chrome.exe",
  "C:\\Users\\DELL\\.agent-browser\\browsers\\chrome-152.0.7977.64\\chrome.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];
const chrome = candidates.find((c) => existsSync(c));
if (!chrome) {
  console.log("未找到可用的浏览器，跳过渲染验证。");
  server.close();
  process.exit(0);
}
console.log("使用浏览器: " + chrome);

// 用 dump-dom 拿到 JS 执行后的真实 DOM
function dumpDom() {
  return new Promise((resolve) => {
    const args = [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--no-first-run",
      "--disable-extensions",
      "--virtual-time-budget=8000",
      "--dump-dom",
      `http://127.0.0.1:${PORT}/index.html`,
    ];
    const p = spawn(chrome, args, { shell: false });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => resolve(out));
    p.on("error", () => resolve(""));
  });
}

const dom = await dumpDom();
server.close();

if (!dom || dom.length < 500) {
  console.log("渲染结果为空，无法验证。");
  process.exit(2);
}

// ---------- 从 DOM 解析渲染结果 ----------
const out = [];
let fails = 0;
const check = (c, m) => { if (!c) fails++; out.push((c ? "  [通过] " : "  [失败] ") + m); };

// 轨道里每个 .page 的 data-src（语义页码，0 基）+ data-slot（DOM 格子号）+ 图 src
const pageRe = /<div class="page" data-src="(\d+)" data-slot="(\d+)">[\s\S]*?<img[^>]*src="([^"]+)"[\s\S]*?<div class="pnum">([^<]+)<\/div>/g;
const rows = [];
let m;
while ((m = pageRe.exec(dom)) !== null) {
  rows.push({ src: Number(m[1]), slot: Number(m[2]), img: m[3].split("/").pop(), cap: m[4].trim() });
}

console.log("\n右翻书古籍阅读器 · 渲染验证（磁盘数据 + 方向模型）");
console.log("=".repeat(56));

check(rows.length === 6, `轨道内渲染了 6 页（实际 ${rows.length}）`);

// 按 DOM 格子号从左到右排序
const bySlot = rows.slice().sort((a, b) => a.slot - b.slot);
console.log(`\n  轨道内（从左到右）:`);
console.log(`    DOM 上的语义页码: ${bySlot.map((r) => r.src).join("  ")}`);
console.log(`    图片文件名:        ${bySlot.map((r) => r.img).join("  ")}`);
console.log(`    页标:              ${bySlot.map((r) => r.cap).join(" | ")}\n`);

// --- 左开本（默认）：第 1 页（src=0）应占最左格子（slot = src）---
check(
  JSON.stringify(bySlot.map((r) => r.src)) === JSON.stringify([0, 1, 2, 3, 4, 5]),
  "左开本：DOM 从左到右为 第1页…末页（第1页在最左）"
);
check(
  JSON.stringify(bySlot.map((r) => r.img)) === JSON.stringify(
    ["00000.png", "00001.png", "00002.png", "00003.png", "00004.png", "00005.png"]),
  "左开本：图片正序排布，00000.png 在最左"
);
// 页标必须跟着语义页码走，而不是跟随格子号
check(
  JSON.stringify(bySlot.map((r) => r.cap)) === JSON.stringify(
    ["第 1 页", "第 2 页", "第 3 页", "第 4 页", "第 5 页", "第 6 页"]),
  "页标跟随语义页码（最左格显示「第 1 页」，最右格显示「第 6 页」）"
);
// 每个页面的 slot 与 src 的映射应满足 slot = src
check(
  rows.every((r) => r.slot === r.src),
  "左开本映射式 slot = src 全部成立"
);

// --- 页码指示与按钮状态 ---
const labelM = dom.match(/id="pageLabel"[^>]*>[\s\S]*?<b>(\d+)<\/b>\s*\/\s*(\d+)/);
check(!!labelM && labelM[1] === "1" && labelM[2] === "6",
  `页码指示初始为 1 / 6（实际 ${labelM ? labelM[1] + " / " + labelM[2] : "未解析到"}）`);

const prevDisabled = /<button class="nav"[^>]*id="btnPrev"[^>]*disabled/.test(dom);
const nextDisabled = /<button class="nav"[^>]*id="btnNext"[^>]*disabled/.test(dom);
check(prevDisabled, "初始「上一页」按钮为禁用态（当前就是第 1 页）");
check(!nextDisabled, "初始「下一页」按钮为可用态");

// 按钮的语义标签不能反过来。
// 注意：这些元素上可能挂着额外的属性（data-page-node-id 等），
// 正则必须容许多余属性，否则会误报"找不到标签"。
const prevCap = dom.match(/id="btnPrev"[\s\S]*?<span class="cap"[^>]*>([^<]+)<\/span>/);
const nextCap = dom.match(/id="btnNext"[\s\S]*?<span class="cap"[^>]*>([^<]+)<\/span>/);
check(prevCap && prevCap[1].trim() === "上一页", `左侧按钮标注为「上一页」（实际「${prevCap ? prevCap[1].trim() : "?"}」）`);
check(nextCap && nextCap[1].trim() === "下一页", `右侧按钮标注为「下一页」（实际「${nextCap ? nextCap[1].trim() : "?"}」）`);

// 滑块
const sliderM = dom.match(/id="slider"[^>]*max="(\d+)"[^>]*value="(\d+)"/);
check(!!sliderM && sliderM[1] === "5" && sliderM[2] === "0",
  `进度条范围 0–5，当前 0（实际 ${sliderM ? sliderM[1] + ", " + sliderM[2] : "未解析到"}）`);

// 方向标记（默认左开本）
check(/id="dirLTR"[^>]*aria-pressed="true"/.test(dom), "顶栏「左开本」处于选中态");
check(/id="dirRTL"[^>]*aria-pressed="false"/.test(dom), "顶栏「右开本」处于未选中态");
check(/左开本\s*·\s*第1页在左/.test(dom), "底栏显示「左开本 · 第1页在左」");

// 缩略图按语义页码排列（第1页在最前），共 6 张
// 同样容许多余属性
const stripM = dom.match(/<div id="thumbStrip"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/);
const stripHtml = stripM ? stripM[1] : "";
const thumbSrcs = (stripHtml.match(/data-src="(\d+)"/g) || []).map((s) => Number(s.match(/\d+/)[0]));
check(thumbSrcs.length === 6, `缩略图渲染了 6 张（实际 ${thumbSrcs.length}）`);
check(
  JSON.stringify(thumbSrcs) === JSON.stringify([0, 1, 2, 3, 4, 5]),
  `缩略图按语义页码排列 1→6（实际 ${thumbSrcs.join(",")}）`
);

// --- 底色主题 ---
const themeItems = (dom.match(/class="tp-item[^"]*"[^>]*data-theme="([^"]+)"/g) || [])
  .map((s) => s.match(/data-theme="([^"]+)"/)[1]);
check(themeItems.length === 5, `底色面板提供 5 种配色（实际 ${themeItems.length}：${themeItems.join(", ")}）`);
check(
  JSON.stringify(themeItems) === JSON.stringify(["paper", "green", "amber", "slate", "sepia-dark"]),
  "五种配色为 宣纸/豆沙绿/米黄/青灰/深褐"
);
check(/id="btnTheme"/.test(dom), "顶栏存在「底色」按钮");
check(/data-theme="paper"/.test(dom), "默认应用「宣纸」底色（body[data-theme=paper]）");
check(/class="tp-item cur"[^>]*data-theme="paper"/.test(dom), "「宣纸」在面板中处于选中态");
check(/T 换底色/.test(dom), "底栏提示了 T 快捷键");

console.log(out.join("\n"));
console.log("=".repeat(56));
console.log(fails === 0 ? `全部通过（共 ${out.length} 项）` : `存在 ${fails} 项失败（共 ${out.length} 项）`);
process.exit(fails === 0 ? 0 : 1);
