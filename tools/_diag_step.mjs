/**
 * 临时诊断 4：让 dropFile 的每一步都可观测，定位到底哪一步卡住。
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

const PORT = 8983, PORT_CDP = 9503;
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

const server = await serve(ROOT, PORT);
const browser = await launch({ cdpPort: PORT_CDP, profileDir: path.join(HERE, ".cdp-diag4") });
log("up");
const send = browser.send;

try {
  await browser.navigate(`${server.url}index.html`, 2600);
  log("loaded; total=" + (await browser.evalJs(`window.gushiReader.state().total`)));

  const pdfPath = path.join(ROOT, "tools", "demo-book.pdf");
  const buf = (await import("node:fs")).readFileSync(pdfPath);
  log(`pdf bytes=${buf.length}`);

  const b64 = buf.toString("base64");
  log(`b64 chars=${b64.length}`);

  // 步骤 1：装好容器
  await browser.evalJs(`window.__p=[];window.__n='demo-book.pdf';window.__m='application/pdf';window.__do=function(){
    try{
      var bin=atob(window.__p.join(""));
      var arr=new Uint8Array(bin.length);
      for(var i=0;i<bin.length;i++) arr[i]=bin.charCodeAt(i);
      var f=new File([arr],window.__n,{type:window.__m});
      var dt=new DataTransfer(); dt.items.add(f);
      window.dispatchEvent(new DragEvent("drop",{dataTransfer:dt,bubbles:true,cancelable:true}));
      window.__p=[]; return "ok:"+arr.length;
    }catch(e){ return "err: "+(e&&e.message); }
  }; "ready"`);
  log("container ready; eval alive=" + (await browser.evalJs(`1+1`)));

  // 步骤 2：分片注入（必须带 executionContextId，否则 CDP 静默不执行）
  const ctx = await browser.currentContextId();
  log("executionContextId=" + ctx);
  const PER = 24 * 1024 * 1024;
  let n = 0;
  for (let i = 0; i < b64.length; i += PER) {
    const slice = b64.slice(i, i + PER);
    const t = Date.now();
    const r = await send("Runtime.callFunctionOn", {
      functionDeclaration: "function(part){ window.__p.push(part); return window.__p.length; }",
      arguments: [{ value: slice }],
      returnByValue: true,
      executionContextId: ctx,
    });
    n++;
    log(`push #${n} chars=${slice.length} took=${Date.now() - t}ms -> ${JSON.stringify(r.result?.result?.value)}`);
  }
  log("injection done; __p.length=" + (await browser.evalJs(`window.__p.length`)));

  // 步骤 3：派发 drop
  log("calling __do() (派发 drop，这里可能长阻塞)");
  const tDrop = Date.now();
  const res = await browser.evalJs(`window.__do()`);
  log(`__do() returned in ${Date.now() - tDrop}ms -> ${res}`);

  // 步骤 4：轮询
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    let st;
    try {
      st = await browser.evalJson(`JSON.stringify(window.gushiReader.state())`);
    } catch (e) {
      log(`poll ${i}: eval FAILED ${e.message}`);
      continue;
    }
    log(`poll ${i}: total=${st.total} ready=${st.ready} hist=${st.history}`);
    if (st.total >= 6) { log("PARSED"); break; }
  }
} finally {
  await browser.close();
  await server.close();
  log("done");
}
process.exit(0);
