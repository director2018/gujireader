/**
 * 临时诊断 2：在真实浏览器里量一下"按 300DPI 渲染 1 页 + toBlob(PNG)"的耗时。
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

const PORT = 8981, PORT_CDP = 9501;
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

const server = await serve(ROOT, PORT);
const browser = await launch({ cdpPort: PORT_CDP, profileDir: path.join(HERE, ".cdp-diag2") });
log("up");

try {
  await browser.navigate(`${server.url}index.html`, 2600);
  log("loaded");

  // 用页面里已有的 pdf.js 打开一个小 PDF，量渲染成本
  const r = await browser.evalJs(`
    (function(){
      window.__t = { step:'start' };
      return 'armed';
    })()
  `);
  log("armed: " + r);

  const res = await browser.evalJs(`
    (async function(){
      const t = [];
      const log = (k) => t.push(k + '=' + Math.round(performance.now()));
      const t0 = performance.now();
      try{
        // 复用页面里的 pdf.js
        const m = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js');
        t.push('src=cdn');
      }catch(e){ t.push('cdn-fail=' + e.message); }
      return t.join(' | ') + ' total=' + Math.round(performance.now()-t0);
    })()
  `, { awaitPromise: true });
  log("result: " + res);
} finally {
  await browser.close();
  await server.close();
  log("done");
}
process.exit(0);
