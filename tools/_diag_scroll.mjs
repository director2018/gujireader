/**
 * 临时诊断：滚动条位置 vs 「第 1 页可见」的真实几何关系。
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

const PORT = 8931, PORT_CDP = 9431;
const server = await serve(ROOT, PORT);
const browser = await launch({ cdpPort: PORT_CDP, profileDir: path.join(HERE, ".cdp-diag") });

const dump = () => browser.evalJson(`JSON.stringify((function(){
  var stage = document.getElementById('stage');
  var track = document.getElementById('track');
  var cs = getComputedStyle(track);
  var pages = Array.prototype.slice.call(track.querySelectorAll('.page'));
  return {
    stage: { clientW: stage.clientWidth, scrollW: stage.scrollWidth,
             maxScroll: stage.scrollWidth - stage.clientWidth,
             scrollLeft: Math.round(stage.scrollLeft),
             cls: stage.className },
    track: { offsetLeft: track.offsetLeft, clientW: track.clientWidth,
             rectW: Math.round(track.getBoundingClientRect().width),
             padL: cs.paddingLeft, padR: cs.paddingRight, gap: cs.gap,
             transform: cs.transform },
    pages: pages.map(function(el){
      var r = el.getBoundingClientRect();
      return { src: Number(el.dataset.src), offsetLeft: Math.round(el.offsetLeft),
               w: Math.round(el.offsetWidth),
               rectL: Math.round(r.left), rectR: Math.round(r.right) };
    }),
    thumbs: (function(){
      var t = document.getElementById('thumbs');
      if (!t) return null;
      return { scrollLeft: Math.round(t.scrollLeft), max: t.scrollWidth - t.clientWidth,
               cls: t.className };
    })()
  };
})())`);

try {
  await browser.navigate(`${server.url}index.html`, 2600);
  console.log("=== 适应窗口（未缩放）===");
  console.log(JSON.stringify(await dump(), null, 1));

  // 放大两级进入滚动模式
  await browser.evalJs(`window.goTo(0, false)`);
  await sleep(500);
  await browser.evalJs(`document.getElementById('btnIn').click()`);
  await browser.evalJs(`document.getElementById('btnIn').click()`);
  await sleep(1200);

  console.log("\n=== 放大后（当前在第 1 页）===");
  const z = await dump();
  console.log(JSON.stringify(z, null, 1));
  const st = await browser.evalJson(`JSON.stringify(window.gushiReader.state())`);
  console.log("state:", JSON.stringify(st));
  console.log("滚动条位置比例 scrollLeft/max =",
    z.stage.maxScroll ? (z.stage.scrollLeft / z.stage.maxScroll).toFixed(3) : "n/a");

  // 第 1 页在当前视野里的可见比例
  const vis = await browser.evalJson(`JSON.stringify((function(){
    var stage=document.getElementById('stage');
    var sr=stage.getBoundingClientRect();
    var out=[];
    Array.prototype.slice.call(document.querySelectorAll('#track .page')).forEach(function(el){
      var b=el.getBoundingClientRect();
      var w=b.width||1;
      var vis=Math.min(b.right,sr.right)-Math.max(b.left,sr.left);
      out.push({src:Number(el.dataset.src), ratio:+(Math.max(0,Math.min(1,vis/w))).toFixed(3)});
    });
    return out;
  })())`);
  console.log("\n各页在视野中的可见比例：", JSON.stringify(vis));

  // 手动把滚动条拖到中间，看第 1 页是否可见
  await browser.evalJs(`document.getElementById('stage').scrollLeft = ${Math.round(z.stage.maxScroll / 2)}`);
  await sleep(600);
  const mid = await dump();
  const visMid = await browser.evalJson(`JSON.stringify((function(){
    var stage=document.getElementById('stage');
    var sr=stage.getBoundingClientRect();
    var out=[];
    Array.prototype.slice.call(document.querySelectorAll('#track .page')).forEach(function(el){
      var b=el.getBoundingClientRect();
      var w=b.width||1;
      var vis=Math.min(b.right,sr.right)-Math.max(b.left,sr.left);
      out.push({src:Number(el.dataset.src), ratio:+(Math.max(0,Math.min(1,vis/w))).toFixed(3)});
    });
    return out;
  })())`);
  console.log("\n=== 滚动条拖到中间 (scrollLeft=" + mid.stage.scrollLeft + ") ===");
  console.log("各页可见比例：", JSON.stringify(visMid));
} finally {
  await browser.close();
  await server.close();
}
process.exit(0);
