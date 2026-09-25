/**
 * 临时诊断：验证「图片未加载 ⟹ 轨道宽度偏小 ⟹ 滚动位置算错」这一假设。
 *
 * 做法：先把页面图片请求全部拦掉，让 .page 宽度为 0（img 撑不开），
 * 此时进入缩放模式；再把图片放行、让其真正加载，观察：
 *   - 轨道宽度 / 最大滚动量 是否变大
 *   - scrollLeft 是否还停在旧位置（= 用户看到的"滚动条停在中间"）
 *   - 第 1 页是否被挤到视野右侧之外
 * 用完即删。
 */
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const HARNESS = path.join(os.homedir(), ".workbuddy", "skills",
  "headless-web-verify", "scripts", "_harness.mjs");
const { serve, launch, sleep } = await import(pathToFileURL(HARNESS).href);

const PORT = 8933, PORT_CDP = 9433;
const server = await serve(ROOT, PORT);
const browser = await launch({ cdpPort: PORT_CDP, profileDir: path.join(HERE, ".cdp-diag2") });
const send = browser.send;

const probe = () => browser.evalJson(`JSON.stringify((function(){
  var stage=document.getElementById('stage'), track=document.getElementById('track');
  var sr=stage.getBoundingClientRect();
  var imgs=Array.prototype.slice.call(track.querySelectorAll('.page'));
  var p1=null;
  imgs.forEach(function(el){
    if (Number(el.dataset.src)===0){
      var b=el.getBoundingClientRect();
      var vis=Math.min(b.right,sr.right)-Math.max(b.left,sr.left);
      p1={ w:Math.round(b.width), rectL:Math.round(b.left), rectR:Math.round(b.right),
           ratio:+(Math.max(0,Math.min(1,vis/(b.width||1)))).toFixed(3) };
    }
  });
  return {
    stageClientW: stage.clientWidth,
    trackW: Math.round(track.getBoundingClientRect().width),
    maxScroll: stage.scrollWidth - stage.clientWidth,
    scrollLeft: Math.round(stage.scrollLeft),
    pageWidths: imgs.map(function(el){ return Math.round(el.getBoundingClientRect().width); }),
    loaded: Array.prototype.filter.call(track.querySelectorAll('img'), function(i){ return i.naturalWidth>0; }).length,
    totalImgs: track.querySelectorAll('img').length,
    page1: p1
  };
})())`);

try {
  await send("Network.enable");
  // ① 先拦住所有页面图片
  await send("Network.setBlockedURLs", { urls: ["*data/pages/*"] });

  await browser.navigate(`${server.url}index.html`, 2600);
  console.log("① 图片被拦截时（尚未放大）：");
  console.log(JSON.stringify(await probe()));

  // ② 在图片没加载的状态下进入缩放模式
  await browser.evalJs(`window.goTo(0, false)`);
  await sleep(300);
  await browser.evalJs(`document.getElementById('btnIn').click()`);
  await browser.evalJs(`document.getElementById('btnIn').click()`);
  await sleep(1000);
  const beforeFix = await probe();
  console.log("\n② 图片被拦截时进入缩放模式：");
  console.log(JSON.stringify(beforeFix));
  console.log("   state:", JSON.stringify(await browser.evalJson(`JSON.stringify(window.gushiReader.state())`)));

  // ③ 放行图片，并强制重新加载
  await send("Network.setBlockedURLs", { urls: [] });
  await browser.evalJs(`(function(){
    document.querySelectorAll('#track img').forEach(function(im){
      var u = im.getAttribute('src') || im.src;
      im.src = '';
      im.src = u + (u.indexOf('?') >= 0 ? '&' : '?') + 'r=' + Date.now();
    });
    return 'reloading';
  })()`);

  // 等图片真正加载完
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    const p = await probe();
    if (p.loaded === p.totalImgs && p.totalImgs > 0) break;
  }
  await sleep(800);

  const after = await probe();
  console.log("\n③ 图片加载完成后（滚动位置未重新计算）：");
  console.log(JSON.stringify(after));
  console.log("   state:", JSON.stringify(await browser.evalJson(`JSON.stringify(window.gushiReader.state())`)));

  console.log("\n──────── 结论 ────────");
  console.log("最大滚动量: " + beforeFix.maxScroll + " → " + after.maxScroll);
  console.log("scrollLeft : " + beforeFix.scrollLeft + " → " + after.scrollLeft);
  console.log("第 1 页可见比例: " + beforeFix.page1.ratio + " → " + after.page1.ratio);
  console.log("滚动条位置比例: " +
    (beforeFix.maxScroll ? (beforeFix.scrollLeft / beforeFix.maxScroll).toFixed(3) : "n/a") + " → " +
    (after.maxScroll ? (after.scrollLeft / after.maxScroll).toFixed(3) : "n/a"));
} finally {
  await browser.close();
  await server.close();
}
process.exit(0);
