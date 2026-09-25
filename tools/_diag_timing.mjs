/**
 * 临时诊断：测量 PDF 懒渲染改造后的导入速度。
 *   - T_open  ：拖入 → 进度层消失且页数就绪（用户看到书）
 *   - T_all   ：拖入 → pendingPages 归 0（全书图片补齐）
 * 用 6 页 39MB 的 demo-book.pdf，旧版整本渲染约需 6~10 秒才开门。
 */
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const HARNESS = path.join(os.homedir(), ".workbuddy", "skills", "headless-web-verify", "scripts", "_harness.mjs");
const { serve, launch, sleep } = await import(pathToFileURL(HARNESS).href);

const PORT = 8995, PORT_CDP = 9515;
const server = await serve(ROOT, PORT);
const browser = await launch({ cdpPort: PORT_CDP, profileDir: path.join(ROOT, "tools", ".cdp-timing") });

try {
  await browser.navigate(`${server.url}index.html`, 2600);
  // 清掉磁盘书：先清历史，再用空 localStorage 状态直接拖 PDF
  await browser.evalJs(`localStorage.removeItem('gushi-reader-history'); true`);

  const t0 = Date.now();
  const L = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

  const res = await browser.dropFile(path.join(ROOT, "tools", "demo-book.pdf"));
  L(`dropFile -> ${res}`);

  // 等"开门"：进度层消失且页数就绪
  let opened = false;
  while (Date.now() - t0 < 120000) {
    await sleep(300);
    const st = await browser.evalJs(`JSON.stringify({
      prog: document.getElementById('progress').classList.contains('on'),
      total: window.gushiReader.state().total
    })`).then(JSON.parse);
    if (!st.prog && st.total > 0) { opened = true; break; }
  }
  const openMs = Date.now() - t0;
  L(opened ? `开门：${(openMs / 1000).toFixed(1)}s（旧版整本渲染约 6~10s）` : "120s 内未开门！");

  // 首页图片是否已就绪
  const firstOk = await browser.evalJs(`(function(){
    var el = document.querySelector('.page[data-src="0"] img');
    return !!el && el.complete && el.naturalWidth > 0;
  })()`);
  L(`第 1 页图片开门即可见：${firstOk}`);

  // 等全书补齐
  let all = -1;
  while (Date.now() - t0 < 180000) {
    await sleep(500);
    all = await browser.evalJs(`window.gushiReader.state().pendingPages`);
    if (all === 0) break;
  }
  L(`全书就绪：pendingPages=${all}，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // 全书图片完整性
  const integ = await browser.evalJs(`JSON.stringify({
    imgs: document.querySelectorAll('#track .page img').length,
    broken: Array.from(document.querySelectorAll('#track .page img')).filter(function(im){ return im.getAttribute('src') && (!im.complete || im.naturalWidth === 0); }).length,
    srcless: Array.from(document.querySelectorAll('#track .page img')).filter(function(im){ return !im.getAttribute('src'); }).length,
    failed: window.gushiReader.state().failedPages
  })`).then(JSON.parse);
  L(`完整性：破图=${integ.broken} 无src=${integ.srcless} 失败页=${integ.failed}（共 ${integ.imgs} 张）`);

  // 翻到第 4 页（后台可能还没渲染到），测"随看随渲染"的插队响应
  await browser.evalJs(`window.goTo(3, false); true`);
  const t1 = Date.now();
  let ok4 = false;
  while (Date.now() - t1 < 15000) {
    await sleep(250);
    ok4 = await browser.evalJs(`(function(){
      var el = document.querySelector('.page[data-src="3"] img');
      return !!el && el.complete && el.naturalWidth > 0;
    })()`);
    if (ok4) break;
  }
  L(`跳到第 4 页 → 图片就绪用时 ${((Date.now() - t1) / 1000).toFixed(1)}s（${ok4}）`);
} finally {
  await browser.close();
  await server.close();
  process.exit(0);
}
