/**
 * 手抓拖动 + 最近打开历史 —— 端到端验证
 *
 * 两项都是"真交互"功能，静态读代码说明不了问题，必须用真实浏览器
 * 派发真实的 PointerEvent / click，再看 DOM 与 localStorage 的实际变化。
 *
 * 覆盖：
 *   A. 手抓拖动 · 未缩放（拖动翻页）
 *   B. 抓取中的视觉反馈
 *   C. 手抓拖动 · 已缩放（拖动画布）
 *   D. 最近打开历史（记录、持久化、清空、单条删除）
 *   E. 本机文件的历史记录（书签式）
 *   F. 页面定位与滚动起点（预留宽度 / 位置不漂移 / 居中）
 *
 * 运行：node tools/gesture_check.mjs
 */

import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

// 复用无头验证技能里的 harness。用绝对路径导入，
// 避免依赖从这里到 ~/.workbuddy 的相对层级（层数一变就断）。
const HARNESS = path.join(os.homedir(), ".workbuddy", "skills",
  "headless-web-verify", "scripts", "_harness.mjs");
const { serve, launch, sleep, createChecker } = await import(pathToFileURL(HARNESS).href);
const PORT = 8961, PORT_CDP = 9481;

const c = createChecker();
const { check, section } = c;

/** 打印进度并立刻 flush，便于定位卡在哪一步 */
function step(msg) {
  process.stdout.write(`  · ${msg}\n`);
}

const server = await serve(ROOT, PORT);
const browser = await launch({ cdpPort: PORT_CDP, profileDir: path.join(HERE, ".cdp-gesture") });

/**
 * 用真实的 PointerEvent 序列做一次拖动。
 * 必须用 PointerEvent 而不是 MouseEvent —— 页面监听的是 pointerdown/move/up，
 * 用 MouseEvent 派发不会被触发，测试会假通过。
 */
async function dragPointer({ from, dx, dy = 0, steps = 8, button = 0 }) {
  return browser.evalJs(`(function(){
    var stage = document.getElementById('stage');
    var r = stage.getBoundingClientRect();
    var x0 = r.left + ${from.x}, y0 = r.top + ${from.y};
    var pid = 9911;
    function ev(type, x, y){
      return new PointerEvent(type, {
        pointerId: pid, bubbles: true, cancelable: true, composed: true,
        clientX: x, clientY: y, button: ${button}, buttons: 1,
        pointerType: 'mouse', isPrimary: true
      });
    }
    var target = document.elementFromPoint(x0, y0) || stage;
    target.dispatchEvent(ev('pointerdown', x0, y0));
    var steps = ${steps};
    for (var i = 1; i <= steps; i++){
      var x = x0 + ${dx} * (i/steps), y = y0 + ${dy} * (i/steps);
      (document.elementFromPoint(x, y) || stage).dispatchEvent(ev('pointermove', x, y));
    }
    var xEnd = x0 + ${dx}, yEnd = y0 + ${dy};
    (document.elementFromPoint(xEnd, yEnd) || stage).dispatchEvent(ev('pointerup', xEnd, yEnd));
    // 拖完浏览器还会派发 click，这里补上，验证它不会误触发翻页
    (document.elementFromPoint(xEnd, yEnd) || stage).dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, clientX: xEnd, clientY: yEnd, button: 0
    }));
    return 'ok';
  })()`);
}

/** 半按不放：只发 pointerdown + pointermove，用于检查"抓取中"的样式 */
async function pressAndHold({ from, dx, dy = 0 }) {
  return browser.evalJs(`(function(){
    var stage = document.getElementById('stage');
    var r = stage.getBoundingClientRect();
    var x0 = r.left + ${from.x}, y0 = r.top + ${from.y};
    var pid = 9922;
    function ev(type, x, y){
      return new PointerEvent(type, {
        pointerId: pid, bubbles: true, cancelable: true, composed: true,
        clientX: x, clientY: y, button: 0, buttons: 1,
        pointerType: 'mouse', isPrimary: true
      });
    }
    var target = document.elementFromPoint(x0, y0) || stage;
    target.dispatchEvent(ev('pointerdown', x0, y0));
    for (var i = 1; i <= 6; i++){
      var x = x0 + ${dx} * (i/6), y = y0 + ${dy} * (i/6);
      (document.elementFromPoint(x, y) || stage).dispatchEvent(ev('pointermove', x, y));
    }
    return 'ok';
  })()`);
}

async function release() {
  return browser.evalJs(`(function(){
    var stage = document.getElementById('stage');
    stage.dispatchEvent(new PointerEvent('pointerup', {
      pointerId: 9922, bubbles: true, cancelable: true,
      clientX: 0, clientY: 0, button: 0, buttons: 0,
      pointerType: 'mouse', isPrimary: true
    }));
    return 'ok';
  })()`);
}

function snap() {
  return browser.evalJson(`JSON.stringify(window.gushiReader.state())`);
}
function label() {
  return browser.evalJs(`document.getElementById('pageLabel').innerText.replace(/\\s/g,'')`);
}

try {
  step("启动：服务已就绪 " + server.url);

  // ================================================================
  section("A. 手抓拖动 · 未缩放（拖动翻页）");
  // ================================================================

  // 从未访问过：历史应为空
  step("A: 载入页面");
  await browser.navigate(`${server.url}index.html`, 2000);
  await browser.evalJs(`localStorage.removeItem('gushi-reader-history')`);
  await browser.navigate(`${server.url}index.html`, 2600);
  step("A: 页面就绪");

  let s = await snap();
  check(s.total === 6, `磁盘模式载入 6 页（实际 ${s.total}）`);
  check(s.idx === 0, `初始在第 1 页（实际第 ${s.idx + 1} 页）`);

  const g0 = await browser.evalJson(`JSON.stringify({
    cursor: getComputedStyle(document.getElementById('stage')).cursor,
    dragging: document.getElementById('stage').classList.contains('grabbing')
  })`);
  check(g0.cursor === "grab", `阅读区默认为抓握手型（实际 ${g0.cursor}）`);
  check(g0.dragging === false, "未拖动时没有 grabbing 类");

  // 往左拖 160px = 下一页
  await dragPointer({ from: { x: 700, y: 400 }, dx: -160 });
  await sleep(650);
  check((await label()) === "2/6", `未缩放模式往左拖 ⇒ 下一页（实际 ${await label()}）`);

  // 往右拖 160px = 上一页
  await dragPointer({ from: { x: 700, y: 400 }, dx: 160 });
  await sleep(650);
  check((await label()) === "1/6", `未缩放模式往右拖 ⇒ 上一页（实际 ${await label()}）`);

  // 拖一点点（未过阈值）不该翻页
  await dragPointer({ from: { x: 700, y: 400 }, dx: -20 });
  await sleep(500);
  check((await label()) === "1/6", `拖动距离不足阈值时不翻页（实际 ${await label()}）`);

  // 纵向拖动不该翻页
  await dragPointer({ from: { x: 700, y: 400 }, dx: -150, dy: 260 });
  await sleep(500);
  check((await label()) === "1/6", `纵向拖动不翻页（实际 ${await label()}）`);

  // 拖动后轨道归位：transform 应回到当前页的对齐位置
  const afterDrag = await browser.evalJson(`JSON.stringify((function(){
    var t = document.getElementById('track');
    return {
      transform: t.style.transform,
      instant: t.classList.contains('instant'),
      grabbing: document.getElementById('stage').classList.contains('grabbing')
    };
  })())`);
  check(afterDrag.instant === false, "松手后去掉 instant（恢复过渡动画）");
  check(afterDrag.grabbing === false, "松手后移除 grabbing 类");

  // ================================================================
  step("A 完成 → B");
  section("B. 抓取中的视觉反馈");
  // ================================================================

  await pressAndHold({ from: { x: 700, y: 400 }, dx: -120 });
  const holding = await browser.evalJson(`JSON.stringify({
    grabbing: document.getElementById('stage').classList.contains('grabbing'),
    dragging: document.getElementById('stage').classList.contains('dragging'),
    cursor: getComputedStyle(document.getElementById('stage')).cursor,
    draggingState: window.gushiReader.state().dragging,
    axis: window.gushiReader.state().dragAxis
  })`);
  check(holding.grabbing === true, "按住并拖动时进入抓取态");
  check(holding.dragging === true, "拖动时阅读区带上 dragging（禁选中）");
  check(holding.cursor === "grabbing", `抓取中光标为抓握手型（实际 ${holding.cursor}）`);
  check(holding.draggingState === true, "对外暴露的 dragging 状态为真");
  check(holding.axis === "x", `主轴锁定为横向（实际 ${holding.axis}）`);

  await release();
  await sleep(600);
  const released = await browser.evalJson(`JSON.stringify({
    grabbing: document.getElementById('stage').classList.contains('grabbing'),
    cursor: getComputedStyle(document.getElementById('stage')).cursor
  })`);
  check(released.grabbing === false, "松手后退出抓取态");
  check(released.cursor === "grab", "松手后光标恢复抓握手型");

  // ================================================================
  step("B 完成 → C");
  section("C. 手抓拖动 · 已缩放（拖动画布）");
  // ================================================================

  // 先回到第 1 页再放大 —— 这样"滚动条停在起点"与"看到第 1 页"才会重合，
  // 该断言才有意义（若停在第 2 页，正确的行为是留在第 2 页而非跳回开头）。
  await browser.evalJs(`window.goTo(0, false)`);
  await sleep(600);

  // 放大到可滚动模式
  await browser.evalJs(`document.getElementById('btnIn').click()`);
  await browser.evalJs(`document.getElementById('btnIn').click()`);
  await sleep(1000);

  let z = await snap();
  check(z.zoomed === true, `已进入缩放模式（zoom=${z.zoom}）`);
  check(z.maxScroll > 0, `内容确实溢出了（maxScroll=${z.maxScroll}）`);

  // 右开本：起点应在最右端
  check(
    Math.abs(z.scrollLeft - z.maxScroll) <= 6,
    `右开本滚动条停在最右端（scrollLeft=${z.scrollLeft}, max=${z.maxScroll}）`
  );

  const before = z.scrollLeft;

  // 右开本的拖动语义：手指把纸往右拉，下一页从左边进来。
  // 换算到 scrollLeft 就是"手指往右拖 ⇒ scrollLeft 减小 ⇒ 看到更靠后的页"。
  // 起点已经是 max（第 1 页贴右端），所以第一下拖不出位移是正常的，
  // 第二次拖才会越过页边界把页码推上去。
  await dragPointer({ from: { x: 500, y: 400 }, dx: 300, button: 0 });
  await sleep(1000);
  await dragPointer({ from: { x: 900, y: 400 }, dx: 300, button: 0 });
  await sleep(1100);
  const after = await snap();
  check(
    after.scrollLeft < before - 100,
    `往右拖使 scrollLeft 明显减小（${before} → ${after.scrollLeft}）`
  );
  check(
    after.idx > z.idx,
    `往右拖推进到后面的页（第 ${z.idx + 1} → 第 ${after.idx + 1} 页）`
  );
  check(
    after.scrollLeft < after.maxScroll - 6,
    `松手后停在拖到的位置，没有被拉回起点（scrollLeft=${after.scrollLeft}）`
  );

  // 反方向拖回去
  const mid = after.scrollLeft;
  const midIdx = after.idx;
  await dragPointer({ from: { x: 900, y: 400 }, dx: -300 });
  await sleep(1100);
  const back = await snap();
  check(
    back.scrollLeft > mid + 100,
    `往左拖使 scrollLeft 明显增加（${mid} → ${back.scrollLeft}）`
  );
  check(
    back.idx <= midIdx,
    `往左拖回退到前面的页（第 ${midIdx + 1} → 第 ${back.idx + 1} 页）`
  );

  // 拖到最左端应能一路看到末页
  await browser.evalJs(`document.getElementById('stage').scrollLeft = 0`);
  await sleep(700);
  const atEnd = await snap();
  check(atEnd.idx === 5, `滚到最左端显示末页（实际第 ${atEnd.idx + 1} 页）`);

  // 松开后不该被吸附走：再读一次，位置与页码都应稳定
  await sleep(800);
  const stable = await snap();
  check(
    stable.scrollLeft === atEnd.scrollLeft && stable.idx === atEnd.idx,
    `末页位置稳定，不被吸附拉走（${atEnd.scrollLeft} → ${stable.scrollLeft}）`
  );

  // 缩放模式下拖动不应改变翻页语义（按钮仍然是上一页/下一页）
  await browser.evalJs(`window.goTo(3, false)`);
  await sleep(700);
  check((await label()) === "4/6", `缩放模式下 goTo 仍按语义页码（实际 ${await label()}）`);

  // 回到适应窗口
  await browser.evalJs(`document.getElementById('btnFit').click()`);
  await sleep(700);
  const fitted = await snap();
  check(fitted.zoomed === false, "点「适应窗口」后退出缩放模式");

  // ================================================================
  step("C 完成 → D");
  section("D. 最近打开历史");
  // ================================================================

  // 清空后重新载入，让 boot() 重新写入一条
  await browser.evalJs(`window.gushiReader.clearHistory()`);
  await sleep(200);
  await browser.navigate(`${server.url}index.html`, 2600);

  const h1 = await browser.evalJson(`JSON.stringify(window.gushiReader.history())`);
  check(h1.length === 1, `载入磁盘书籍后写入 1 条记录（实际 ${h1.length}）`);
  check(h1[0]?.kind === "local", `记录类型为磁盘模式（实际 ${h1[0]?.kind}）`);
  check(h1[0]?.total === 6, `记录页数为 6（实际 ${h1[0]?.total}）`);
  check(
    typeof h1[0]?.name === "string" && h1[0].name.length > 0,
    `记录含书名（「${h1[0]?.name}」）`
  );

  // 翻几页，书签应被写回
  await browser.evalJs(`window.goTo(4, false)`);
  await sleep(700);   // 等过 300ms 的防抖
  const h2 = await browser.evalJson(`JSON.stringify(window.gushiReader.history())`);
  check(h2[0]?.page === 5, `翻到第 5 页后书签同步为 5（实际 ${h2[0]?.page}）`);
  check(h2.length === 1, `同一本书不重复产生记录（实际 ${h2.length} 条）`);

  // 刷新页面，记录应持久化
  await browser.navigate(`${server.url}index.html`, 2600);
  const h3 = await browser.evalJson(`JSON.stringify(window.gushiReader.history())`);
  check(h3.length === 1, `刷新后记录仍在（实际 ${h3.length} 条）`);
  check(h3[0]?.page === 5, `刷新后书签仍为第 5 页（实际 ${h3[0]?.page}）`);

  // 面板：按钮打开、项数正确、H 键切换
  const panelBefore = await browser.evalJs(
    `document.getElementById('histPanel').classList.contains('open')`
  );
  check(panelBefore === false, "历史面板默认收起");

  await browser.evalJs(`document.getElementById('btnHist').click()`);
  await sleep(250);
  const opened = await browser.evalJson(`JSON.stringify({
    open: document.getElementById('histPanel').classList.contains('open'),
    items: document.querySelectorAll('#histList .hp-item').length,
    cur: document.querySelectorAll('#histList .hp-item.cur').length,
    name: (document.querySelector('#histList .hp-name') || {}).textContent || '',
    page: (document.querySelector('#histList .hp-page') || {}).textContent || ''
  })`);
  check(opened.open === true, "点「最近」按钮后面板展开");
  check(opened.items === 1, `面板内 1 条记录（实际 ${opened.items}）`);
  check(opened.cur === 1, "当前正在读的书被标为选中");
  check(opened.page === "5/6", `面板显示进度 5/6（实际 ${opened.page}）`);

  // 面板与底色面板互斥
  await browser.evalJs(`document.getElementById('btnTheme').click()`);
  await sleep(250);
  const excl = await browser.evalJson(`JSON.stringify({
    hist: document.getElementById('histPanel').classList.contains('open'),
    theme: document.getElementById('themePanel').classList.contains('open')
  })`);
  check(excl.theme === true, "点「底色」后底色面板展开");
  check(excl.hist === false, "开底色面板时历史面板自动收起（不重叠）");

  await browser.evalJs(`document.getElementById('btnHist').click()`);
  await sleep(250);
  const excl2 = await browser.evalJson(`JSON.stringify({
    hist: document.getElementById('histPanel').classList.contains('open'),
    theme: document.getElementById('themePanel').classList.contains('open')
  })`);
  check(excl2.hist === true, "点「最近」后历史面板展开");
  check(excl2.theme === false, "开历史面板时底色面板自动收起");

  // 点击面板外部关闭
  await browser.evalJs(`document.body.click()`);
  await sleep(200);
  check(
    (await browser.evalJs(`document.getElementById('histPanel').classList.contains('open')`)) === false,
    "点击面板外部后收起"
  );

  // 空状态提示
  await browser.evalJs(`window.gushiReader.clearHistory()`);
  await sleep(250);
  await browser.evalJs(`document.getElementById('btnHist').click()`);
  await sleep(250);
  const emptyState = await browser.evalJson(`JSON.stringify({
    items: document.querySelectorAll('#histList .hp-item').length,
    hasEmpty: !!document.querySelector('#histList .hp-empty'),
    text: (document.querySelector('#histList .hp-empty') || {}).textContent || ''
  })`);
  check(emptyState.items === 0, "清空后没有记录项");
  check(emptyState.hasEmpty === true, "清空后显示空状态提示");
  check(emptyState.text.includes("还没有记录"), `空状态文案正确（「${emptyState.text}」）`);

  // ================================================================
  step("D 完成 → E（拖放 PDF，较慢，最长约 24s/次）");
  section("E. 本机文件的历史记录（书签式）");
  // ================================================================

  await browser.evalJs(`window.gushiReader.clearHistory()`);
  await sleep(200);
  await browser.evalJs(`document.getElementById('histPanel').classList.remove('open')`);

  step("E: 拖放 demo-book.pdf（第 1 次）");
  // 拖一个 PDF 进去
  await browser.dropFile(path.join(ROOT, "tools", "demo-book.pdf"));
  let ok = false;
  for (let i = 0; i < 40; i++) {
    await sleep(600);
    const st = await snap();
    if (i % 5 === 0) step(`E: 等待解析 ${i * 0.6}s … total=${st.total} ready=${st.ready}`);
    if (st.total >= 6) { ok = true; break; }
  }
  check(ok, "拖放 PDF 后解析出页面");
  step("E: 第 1 次解析完成，pages=" + (await snap()).total);

  await sleep(600);
  const fh = await browser.evalJson(`JSON.stringify(window.gushiReader.history())`);
  check(fh.length === 1, `本机文件也写入 1 条记录（实际 ${fh.length}）`);
  check(fh[0]?.kind === "file", `记录类型标记为本机文件（实际 ${fh[0]?.kind}）`);
  check(fh[0]?.total === 6, `记录的页数为 6（实际 ${fh[0]?.total}）`);
  const fileId = fh[0]?.id || "";
  check(fileId.startsWith("file:"), `记录 id 带 file: 前缀（「${fileId}」）`);

  step("E: 拖放 demo-book.pdf（第 2 次，验重）");
  // 本机文件再次拖入同一份，应沿用同一条记录而不是新增
  await browser.dropFile(path.join(ROOT, "tools", "demo-book.pdf"));
  ok = false;
  for (let i = 0; i < 40; i++) {
    await sleep(600);
    const st = await snap();
    if (st.total >= 6) { ok = true; break; }
  }
  await sleep(600);
  const fh2 = await browser.evalJson(`JSON.stringify(window.gushiReader.history())`);
  check(fh2.length === 1, `同一文件重复打开不新增记录（实际 ${fh2.length} 条）`);

  // 单条删除
  await browser.evalJs(`document.getElementById('btnHist').click()`);
  await sleep(250);
  const delRes = await browser.evalJson(`JSON.stringify((function(){
    var before = document.querySelectorAll('#histList .hp-item').length;
    var btn = document.querySelector('#histList .hp-del');
    if (!btn) return { before: before, clicked: false };
    btn.click();
    return {
      before: before,
      clicked: true,
      after: document.querySelectorAll('#histList .hp-item').length,
      stored: window.gushiReader.history().length
    };
  })())`);
  check(delRes.clicked === true, "记录项上存在删除按钮");
  check(delRes.after === 0, `删除后面板内项数减少（${delRes.before} → ${delRes.after}）`);
  check(delRes.stored === 0, `删除后存储中也移除（剩 ${delRes.stored} 条）`);

  // 容量上限
  step("E: 容量上限 / 损坏数据容错");
  await browser.evalJs(`(function(){
    localStorage.setItem('gushi-reader-history', JSON.stringify(
      Array.from({length: 30}, function(_, i){
        return { id:'fake:'+i, name:'测试书 '+i, kind:'local', total:10, page:1, at: Date.now()-i*1000 };
      })
    ));
  })()`);
  await browser.navigate(`${server.url}index.html`, 2600);
  const capped = await browser.evalJson(`JSON.stringify(window.gushiReader.history())`);
  check(capped.length === 12, `记录数量被限制在 12 条（实际 ${capped.length}）`);
  // 打开阅读器本身会把"当前这本书"提到最前（最近打开理应如此），
  // 所以这里不看第一条是谁，而是看伪造记录之间的先后顺序有没有被打乱。
  const i0 = capped.findIndex((it) => it.name === "测试书 0");
  const i1 = capped.findIndex((it) => it.name === "测试书 1");
  check(i0 >= 0 && i1 >= 0 && i0 < i1,
    `伪造记录仍保持时间倒序（测试书0 在第 ${i0} 位，测试书1 在第 ${i1} 位）`);
  check(capped.some((it) => it.name === "古籍演示本"),
    "当前正在读的书被记入最近打开");

  // 损坏数据不应导致崩溃
  await browser.evalJs(`localStorage.setItem('gushi-reader-history', '{不是合法 JSON')`);
  await browser.navigate(`${server.url}index.html`, 2600);
  const broken = await browser.evalJson(`JSON.stringify({
    hist: window.gushiReader.history(),
    total: window.gushiReader.state().total,
    ready: document.querySelectorAll('#track .page').length
  })`);
  // 坏数据应当被丢弃、而不是把阅读器带崩；
  // 丢掉之后本次打开的这本书会重新记一条，所以最终是「1 条有效记录」。
  check(Array.isArray(broken.hist) && broken.hist.length === 1,
    `损坏数据被丢弃后只剩本次打开的记录（实际 ${broken.hist?.length} 条）`);
  check(broken.hist[0]?.name === "古籍演示本",
    `重新写入的记录是有效的（「${broken.hist[0]?.name}」）`);
  check(broken.total === 6, `数据损坏时阅读器仍正常载入（${broken.total} 页）`);
  check(broken.ready === 6, "页面照常渲染，未被坏数据带崩");

  // ================================================================
  step("E 完成 → F（页面定位与滚动起点）");
  section("F. 页面定位与滚动起点");
  // ================================================================

  // 这一段守的是"第 1 页到底该出现在哪一端"。
  //
  // 历史故障：纸面宽度原本是靠 <img> 撑出来的，图片没加载完时宽度接近 0，
  // 于是算出的滚动范围也是错的；等图片陆续到齐、轨道被撑宽，位置却没人重算。
  // 结果就是滑块停在半路、右开本的第 1 页（最右端）被挤出视野，
  // 用户得自己把滚动条拖到最右边才看得到第 1 页。
  //
  // 所以这里把图片请求整个拦住，逼出"布局先于图片"的场景来验证。
  await browser.send("Network.enable");
  await browser.send("Network.setCacheDisabled", { cacheDisabled: true });
  await browser.send("Network.setBlockedURLs", { urls: ["*data/pages/*"] });
  await browser.evalJs(`localStorage.removeItem('gushi-reader-history')`);
  await browser.navigate(`${server.url}index.html`, 2600);

  const geo = () => browser.evalJson(`JSON.stringify((function(){
    var stage = document.getElementById('stage');
    var track = document.getElementById('track');
    var sr = stage.getBoundingClientRect();
    var out = {
      stageW: stage.clientWidth,
      trackW: Math.round(track.getBoundingClientRect().width),
      maxScroll: stage.scrollWidth - stage.clientWidth,
      scrollLeft: Math.round(stage.scrollLeft),
      zoomed: stage.classList.contains('zoomed'),
      center: Math.round(sr.left + sr.width / 2)
    };
    Array.prototype.slice.call(track.querySelectorAll('.page')).forEach(function(el){
      if (Number(el.dataset.src) !== 0) return;
      var b = el.getBoundingClientRect();
      var vis = Math.min(b.right, sr.right) - Math.max(b.left, sr.left);
      out.page1 = {
        center: Math.round((b.left + b.right) / 2),
        ratio: +(Math.max(0, Math.min(1, vis / (b.width || 1)))).toFixed(3)
      };
    });
    var ims = track.querySelectorAll('img');
    out.imgs = ims.length;
    out.loaded = Array.prototype.filter.call(ims, function(i){ return i.naturalWidth > 0; }).length;
    return out;
  })())`);

  const f1 = await geo();
  check(f1.loaded === 0, `图片确实一张都没加载（共 ${f1.imgs} 张）`);
  check(f1.trackW > f1.stageW,
    `图片没到也照样按原始比例预留了纸面宽度（轨道 ${f1.trackW}px > 视野 ${f1.stageW}px）`);

  // 在"图片还没到"的状态下进入滚动模式
  await browser.evalJs(`window.goTo(0, false)`);
  await sleep(300);
  await browser.evalJs(`document.getElementById('btnIn').click()`);
  await browser.evalJs(`document.getElementById('btnIn').click()`);
  await sleep(1000);

  const f2 = await geo();
  check(Math.abs(f2.scrollLeft - f2.maxScroll) <= 6,
    `图片未加载时进滚动模式，滑块仍停在起点端（${f2.scrollLeft} / ${f2.maxScroll}）`);
  check(f2.page1 && f2.page1.ratio >= 0.99,
    `第 1 页完整可见（露出 ${f2.page1 ? Math.round(f2.page1.ratio * 100) : 0}%）`);

  // 放行图片，等它们真正到齐 —— 位置不应该因此漂移
  await browser.send("Network.setBlockedURLs", { urls: [] });
  await browser.evalJs(`(function(){
    Array.prototype.forEach.call(document.querySelectorAll('#track img'), function(im){
      var u = im.getAttribute('src');
      if (!u || u.indexOf('blob:') === 0) return;
      im.src = '';
      im.src = u + (u.indexOf('?') >= 0 ? '&' : '?') + 'r=' + Date.now();
    });
    return 'reloading';
  })()`);
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    const g = await geo();
    if (g.imgs > 0 && g.loaded === g.imgs) break;
  }
  await sleep(600);

  const f3 = await geo();
  check(f3.loaded === f3.imgs, `图片全部加载完成（${f3.loaded}/${f3.imgs}）`);
  check(f3.maxScroll === f2.maxScroll,
    `图片到齐后最大滚动量不变（${f2.maxScroll} → ${f3.maxScroll}）`);
  check(Math.abs(f3.scrollLeft - f3.maxScroll) <= 6,
    `位置不漂移，滑块仍在起点端（${f3.scrollLeft} / ${f3.maxScroll}）`);
  check(f3.page1 && f3.page1.ratio >= 0.99,
    `第 1 页依然完整可见（露出 ${f3.page1 ? Math.round(f3.page1.ratio * 100) : 0}%）`);

  // 回到适应窗口模式：当前页必须居中，不能偏到一边、右边空一大片
  await browser.evalJs(`document.getElementById('btnFit').click()`);
  await sleep(800);
  const f4 = await geo();
  check(f4.zoomed === false, "已回到适应窗口模式");
  check(Math.abs(f4.page1.center - f4.center) <= 4,
    `当前页水平居中（第 1 页中心 ${f4.page1.center}，视野中心 ${f4.center}）`);

  // 收尾：把网络设置恢复回去，免得影响后续手动排查
  await browser.send("Network.setCacheDisabled", { cacheDisabled: false });

} finally {
  c.report("手抓拖动 + 最近打开历史 验证");
  await browser.close();
  await server.close();
}

process.exit(c.fails === 0 ? 0 : 1);
