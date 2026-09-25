/**
 * 临时诊断 3：量「按 300DPI 渲染一页 → toBlob(PNG)」的真实耗时与内存。
 * 用 inline base64 把 PDF 传进页面（小样本，避免又被注入拖累）。
 * 用完即删。
 */
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const HARNESS = path.join(os.homedir(), ".workbuddy", "skills",
  "headless-web-verify", "scripts", "_harness.mjs");
const { serve, launch, sleep } = await import(pathToFileURL(HARNESS).href);

const PORT = 8991, PORT_CDP = 9511;
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

const server = await serve(ROOT, PORT);
const browser = await launch({ cdpPort: PORT_CDP, profileDir: path.join(HERE, ".cdp-diag3") });
log("up");

try {
  await browser.navigate(`${server.url}index.html`, 2600);
  log("loaded");

  // 直接用页面里已加载的 pdfjsLib（PDFJS_URL 已注入）
  const res = await browser.evalJs(`
    (async function(){
      const out = [];
      const t = () => Math.round(performance.now());
      const lib = window.pdfjsLib;
      if (!lib) return 'no pdfjsLib';

      // 造一个 1 页的 PDF：内容是一个大位图（模拟扫描件），由 pdf.js 自己渲染
      // 这里更简单：拿现成的 data 目录图片不行，直接测 canvas 渲染成本
      const DPI = 300;
      const wPt = 595, hPt = 842;             // A4
      const scale = Math.min(5, Math.max(1, DPI/72));
      const cw = Math.floor(wPt * scale), ch = Math.floor(hPt * scale);

      const t0 = t();
      const canvas = document.createElement('canvas');
      canvas.width = cw; canvas.height = ch;
      const ctx = canvas.getContext('2d', { alpha:false });
      ctx.fillStyle = '#fff'; ctx.fillRect(0,0,cw,ch);
      out.push('canvas ' + cw + 'x' + ch + ' alloc=' + (t()-t0) + 'ms');

      // 画满内容，逼近真实扫描件
      const t1 = t();
      const img = ctx.createImageData(cw, ch);
      for (let i=0;i<img.data.length;i+=4){
        const v = (i % 997) & 0xff;
        img.data[i]=v; img.data[i+1]=v; img.data[i+2]=v; img.data[i+3]=255;
      }
      out.push('fillData=' + (t()-t1) + 'ms');
      ctx.putImageData(img, 0, 0);

      const t2 = t();
      const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
      out.push('toBlobPNG=' + (t()-t2) + 'ms size=' + (blob ? Math.round(blob.size/1024)+'KB' : 'null'));

      const t3 = t();
      const blobJ = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.92));
      out.push('toBlobJPEG=' + (t()-t3) + 'ms size=' + (blobJ ? Math.round(blobJ.size/1024)+'KB' : 'null'));

      out.push('heap=' + (performance.memory ? Math.round(performance.memory.usedJSHeapSize/1048576)+'MB' : 'n/a'));
      return out.join(' | ');
    })()
  `, { awaitPromise: true });
  log("RESULT: " + res);
} finally {
  await browser.close();
  await server.close();
  log("done");
}
process.exit(0);
