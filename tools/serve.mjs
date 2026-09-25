// 右翻书古籍阅读器 —— 固定入口本地服务
// 用法: node tools/serve.mjs   （或直接双击根目录的「启动右翻书.bat」）
//
// 为什么要有这个文件：
//   浏览器的「最近打开」「阅读位置」「设置」「离线缓存」都按**地址**分开存。
//   127.0.0.1:8899 / localhost:8777 / file://… 在浏览器眼里是三个不同的网站，
//   数据互不可见 —— 这就是「上次还能用，这次打开又要重新导入」的根源。
//   所以入口必须固定成同一个地址，且不依赖任何临时进程。
//
// 行为：
//   1) 恒定监听 http://127.0.0.1:8899/（地址写死，保证每次都命中同一份数据）
//   2) 端口已被占用 → 认为服务在跑，只把浏览器打开，不报错、不重复起进程
//   3) 静态文件一律 no-store，保证每次打开都是最新版本的 index.html
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const argv = process.argv.slice(2);
const argOf = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const HOST = "127.0.0.1";
const PORT = Number(argOf("--port", process.env.GUSHI_PORT || 8899));
// GUSHI_NO_OPEN=1 供自动化测试使用：只起服务，不弹浏览器
const OPEN = !argv.includes("--no-open") && process.env.GUSHI_NO_OPEN !== "1";
// 地址写死成 127.0.0.1，不用 localhost：两者在浏览器里算两个站点
const URL_ = `http://${HOST}:${PORT}/`;

const MIME = {
  ".html": "text/html;charset=utf-8",
  ".htm": "text/html;charset=utf-8",
  ".js": "text/javascript;charset=utf-8",
  ".mjs": "text/javascript;charset=utf-8",
  ".css": "text/css;charset=utf-8",
  ".json": "application/json;charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
  ".tif": "image/tiff", ".tiff": "image/tiff", ".svg": "image/svg+xml",
  ".pdf": "application/pdf", ".woff2": "font/woff2",
  ".txt": "text/plain;charset=utf-8", ".md": "text/plain;charset=utf-8",
};

function openBrowser(url){
  if (!OPEN) return;
  try{
    if (process.platform === "win32"){
      // start 是 cmd 内建命令，第一个空参数是窗口标题占位
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin"){
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  }catch(e){ /* 打不开浏览器不影响服务本身 */ }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://x");
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith("/")) p += "index.html";
  const file = path.join(ROOT, p);
  // 不许跳出书库目录
  if (!file.startsWith(ROOT)){ res.writeHead(403); res.end("403"); return; }
  try{
    const st = await stat(file);
    if (st.isDirectory()){ res.writeHead(302, { Location: p + "/" }); res.end(); return; }
    const data = await readFile(file);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  }catch{
    res.writeHead(404, { "Content-Type": "text/plain;charset=utf-8" });
    res.end("404 " + p);
  }
});

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE"){
    // 端口已在服务：说明上次的窗口还开着（或另有实例），直接开浏览器最省事
    console.log("");
    console.log("  阅读器已经在运行，正在为你打开 " + URL_);
    console.log("  （要停止服务，请关闭那个显示本提示的黑色窗口）");
    console.log("");
    openBrowser(URL_);
    // 退出码 3 = 「已在运行」，供启动脚本区分，不要显示成启动失败
    setTimeout(() => process.exit(3), 600);
    return;
  }
  console.error("启动失败：" + (err && err.message));
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("  右翻书古籍阅读器");
  console.log("  --------------------------------------------------");
  console.log("  地址: " + URL_);
  console.log("  请始终用这个地址打开（阅读记录与离线缓存都存在这里）");
  console.log("  按 Ctrl+C 或关闭本窗口即停止服务");
  console.log("");
  openBrowser(URL_);
});
