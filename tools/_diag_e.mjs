/**
 * 临时诊断：只跑 E 节（本机文件拖放），逐步打印，定位卡点。
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

const PORT = 8971, PORT_CDP = 9491;
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

log("starting server");
const server = await serve(ROOT, PORT);
log("server up " + server.url);
const browser = await launch({ cdpPort: PORT_CDP, profileDir: path.join(HERE, ".cdp-diag") });
log("browser up");

try {
  log("navigating");
  await browser.navigate(`${server.url}index.html`, 2600);
  log("navigated");

  const s0 = await browser.evalJson(`JSON.stringify(window.gushiReader.state())`);
  log("state: total=" + s0.total + " idx=" + s0.idx);

  await browser.evalJs(`window.gushiReader.clearHistory()`);
  log("history cleared");

  const pdf = path.join(ROOT, "tools", "demo-book.pdf");
  log("dropping " + pdf);
  await browser.dropFile(pdf);
  log("drop dispatched");

  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    let st;
    try {
      st = await browser.evalJson(`JSON.stringify(window.gushiReader.state())`);
    } catch (e) {
      log(`poll ${i}: eval FAILED -> ${e.message}`);
      continue;
    }
    const dom = await browser.evalJs(
      `document.querySelectorAll('#track .page').length + '/' + (document.getElementById('loading')||{}).className`
    );
    log(`poll ${i}: total=${st.total} ready=${st.ready} pages=${dom} hist=${st.history}`);
    if (st.total >= 6) { log("PARSED"); break; }
  }

  const consoleErrors = await browser.evalJs(`window.__err || 'none'`);
  log("page errors: " + consoleErrors);
} finally {
  log("closing");
  await browser.close();
  await server.close();
  log("done");
}
process.exit(0);
