#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
右翻书古籍阅读器 —— 页面构建脚本

把 PDF / 图片（或包含图片的目录）转换成阅读器所需的页面序列，
并生成 data/manifest.json（以及供 file:// 直开的 data/manifest.embed.js）。

设计原则：**画质无损**

* 图片输入 -> 原文件字节级复制，不重新编码、不缩放、不改变色深。
* PDF 输入 -> 用 PyMuPDF 的 pixmap 直接取原始像素，写 PNG（flate 无损），
  不做 JPEG 质量压缩、不做降采样。默认 zoom=0（跟随 PDF 内嵌图像原生分辨率）。
* `--max-width` 是有损缩放，默认关闭，需要时才用。

页序：默认按「右开本」把页面逆序写入 manifest，使第 1 页出现在最右侧。
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------- 常量

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff", ".webp", ".gif", ".jfif"}

LOSSLESS_COPY_EXTS = {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".jfif"}

# 重新编码时必须用无损参数的格式
LOSSLESS_REENCODE = {".png", ".bmp", ".tif", ".tiff"}


def log(msg: str) -> None:
    print(msg, flush=True)


# ---------------------------------------------------------------- 自然排序


def natural_key(name: str):
    """让 page2 排在 page10 前面。"""
    import re

    parts = re.split(r"(\d+)", name)
    return [int(p) if p.isdigit() else p.lower() for p in parts]


# ---------------------------------------------------------------- 输入收集


def collect_inputs(paths: list[Path]) -> list[Path]:
    """把命令行参数展开成有序的文件列表。"""
    files: list[Path] = []
    for p in paths:
        if not p.exists():
            log(f"[警告] 路径不存在，已跳过：{p}")
            continue
        if p.is_dir():
            found = [f for f in p.iterdir() if f.is_file() and f.suffix.lower() in IMAGE_EXTS]
            found.sort(key=lambda f: natural_key(f.name))
            log(f"[输入] 目录 {p} -> 找到 {len(found)} 个图片文件")
            files.extend(found)
        else:
            files.append(p)
    return files


# ---------------------------------------------------------------- PDF


def page_native_zoom(page, target_dpi: float) -> float:
    """
    估算让输出分辨率贴近 PDF 内嵌图像原生分辨率所需的 zoom。

    扫描 PDF 常见形态是「整页一张图」。此时按图像尺寸 / 页面尺寸反推 zoom，
    即可做到 1:1 无损导出。

    若无法判断（矢量页码、多图拼页），退回到 target_dpi 对应的 zoom。
    """
    base = target_dpi / 72.0
    try:
        infos = page.get_image_info()
    except Exception:
        return base

    if not infos:
        return base

    rect = page.rect
    if rect.width <= 0 or rect.height <= 0:
        return base

    zooms = []
    for info in infos:
        w = info.get("width") or 0
        h = info.get("height") or 0
        bbox = info.get("bbox")
        if w <= 0 or h <= 0 or not bbox:
            continue
        bw = bbox[2] - bbox[0]
        bh = bbox[3] - bbox[1]
        if bw <= 0 or bh <= 0:
            continue
        zooms.append(min(w / bw, h / bh))

    if not zooms:
        return base

    # 单张整页扫描图：直接用它的比例，天然无损
    z = max(zooms)
    if len(zooms) == 1:
        return z
    # 多图页：取整页比例，避免只放大到某张小图而显得含糊
    return min(z, base * 4)


def build_from_pdf(
    src: Path,
    pages_dir: Path,
    target_dpi: float,
    max_width: int | None,
    start_index: int,
) -> tuple[list[dict], int]:
    import pymupdf

    doc = pymupdf.open(src)
    entries: list[dict] = []
    count = doc.page_count
    log(f"[PDF] {src.name}：共 {count} 页")

    for i in range(count):
        page = doc.load_page(i)
        zoom = page_native_zoom(page, target_dpi)

        # 若设置了 max-width，先按 zoom 渲染再等比缩小（有损，需用户显式开启）
        pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
        if max_width and pix.width > max_width:
            shrink = max_width / pix.width
            pix = page.get_pixmap(
                matrix=pymupdf.Matrix(zoom * shrink, zoom * shrink), alpha=False
            )

        out_name = f"{start_index + len(entries):05d}.png"
        out_path = pages_dir / out_name
        # PNG 为 flate 无损编码，是这里唯一使用的图片输出格式
        pix.save(str(out_path))
        pix = None

        entries.append(
            {
                "file": f"pages/{out_name}",
                "label": f"第 {len(entries) + 1} 页",
                "w": _png_size(out_path)[0],
                "h": _png_size(out_path)[1],
                "source": f"{src.name}#{i + 1}",
            }
        )
        if (i + 1) % 20 == 0 or i == count - 1:
            log(f"       已导出 {i + 1}/{count} 页")

    doc.close()
    return entries, count


def _png_size(path: Path) -> tuple[int, int]:
    """只读 PNG 头，拿到宽高，避免整图解码。"""
    try:
        with path.open("rb") as fh:
            head = fh.read(33)
        if head[:8] != b"\x89PNG\r\n\x1a\n":
            return (0, 0)
        w = int.from_bytes(head[16:20], "big")
        h = int.from_bytes(head[20:24], "big")
        return (w, h)
    except Exception:
        return (0, 0)


# ---------------------------------------------------------------- 图片


def build_from_images(
    files: list[Path],
    pages_dir: Path,
    start_index: int,
    verbose: bool = True,
) -> list[dict]:
    entries: list[dict] = []
    for f in files:
        idx = start_index + len(entries)
        ext = f.suffix.lower()

        # 情况一：本身就是可无损承载的格式 -> 字节级复制，零损失、零编码
        if ext in LOSSLESS_COPY_EXTS:
            out_name = f"{idx:05d}{ext}"
            shutil.copy2(f, pages_dir / out_name)
            w, h = _probe_size(pages_dir / out_name, ext)
            note = "原样复制"
        else:
            # 情况二：webp/gif 等 -> 解码后以 PNG 无损保存
            from PIL import Image

            out_name = f"{idx:05d}.png"
            with Image.open(f) as im:
                im.save(pages_dir / out_name, format="PNG", optimize=False, compress_level=6)
                w, h = im.size
            note = "转 PNG（无损）"

        entries.append(
            {
                "file": f"pages/{out_name}",
                "label": f"第 {len(entries) + 1} 页",
                "w": w,
                "h": h,
                "source": f.name,
            }
        )
        if verbose:
            log(f"       {f.name} -> {out_name}  ({w}x{h}, {note})")

    return entries


def _probe_size(path: Path, ext: str) -> tuple[int, int]:
    """尽量不完整解码就拿到尺寸。"""
    if ext == ".png":
        return _png_size(path)
    try:
        from PIL import Image

        with Image.open(path) as im:
            return im.size
    except Exception:
        return (0, 0)


# ---------------------------------------------------------------- manifest


def write_manifest(
    out_path: Path,
    entries: list[dict],
    title: str,
    direction: str,
    source_desc: str,
) -> dict:
    """
    写 manifest.json。

    页序在这里处理：`readingOrder` 给出阅读器应当依次渲染的页面索引。

    * right-to-left（右开本，默认）
        order = 逆序。第 1 页排在数组末尾 -> 落在最右侧，翻页时页面自右向左推进。
    * left-to-right（现代左开本）
        order = 正序。
    """
    n = len(entries)
    order = list(range(n - 1, -1, -1)) if direction == "right-to-left" else list(range(n))

    manifest = {
        "title": title,
        "direction": direction,
        "source": source_desc,
        "generatedAt": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "pageCount": n,
        "readingOrder": order,
        "pages": entries,
    }
    out_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    # 同时写一份用 <script> 引入的副本。原因：双击 index.html（file://）时
    # 浏览器禁止 fetch() 读取本地文件，书库清单会读不到而显示空白页；
    # <script src> 不受这条限制，所以直开也能正常显示演示库。
    out_path.with_name("manifest.embed.js").write_text(
        "// 由 build_reader.py 自动生成，与 manifest.json 内容一致，请勿手改。\n"
        "window.__GUSHI_MANIFEST = "
        + json.dumps(manifest, ensure_ascii=False)
        + ";\n",
        encoding="utf-8",
    )
    return manifest


# ---------------------------------------------------------------- main


def main() -> int:
    ap = argparse.ArgumentParser(
        description="把古籍扫描件（PDF / 图片）构建成右开本网页阅读器的数据。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="示例：\n"
        '  python build_reader.py "C:\\古籍\\藏书.pdf"\n'
        "  python build_reader.py ./扫描图 --direction left-to-right\n"
        '  python build_reader.py a.jpg b.jpg c.jpg --title "某某藏书"',
    )
    ap.add_argument("inputs", nargs="+", type=Path, help="PDF 文件、图片文件，或包含图片的目录")
    ap.add_argument(
        "--out",
        type=Path,
        default=None,
        help="阅读器根目录（默认：脚本上一级目录 gushi-reader）",
    )
    ap.add_argument("--title", default=None, help="书名，显示在阅读器顶部")
    ap.add_argument(
        "--direction",
        choices=["right-to-left", "left-to-right"],
        default="right-to-left",
        help="装帧方向：right-to-left 为古籍右开本（默认，页面逆序）",
    )
    ap.add_argument(
        "--dpi",
        type=float,
        default=300.0,
        help="PDF 渲染 DPI，仅当无法判定内嵌图像原生分辨率时生效（默认 300）",
    )
    ap.add_argument(
        "--max-width",
        type=int,
        default=None,
        help="限制页面最大宽度（像素）。注意：这是有损缩放，默认关闭以保画质",
    )
    ap.add_argument("--clean", action="store_true", help="构建前清空 data/pages 目录")
    args = ap.parse_args()

    # 定位输出根目录
    script_dir = Path(__file__).resolve().parent
    root = args.out.resolve() if args.out else (script_dir.parent)
    data_dir = root / "data"
    pages_dir = data_dir / "pages"

    if args.clean and pages_dir.exists():
        shutil.rmtree(pages_dir)
        log("[清理] 已清空 data/pages")
    pages_dir.mkdir(parents=True, exist_ok=True)

    inputs = collect_inputs(args.inputs)
    if not inputs:
        log("[错误] 没有找到任何可处理的输入文件。")
        return 1

    pdfs = [f for f in inputs if f.suffix.lower() == ".pdf"]
    imgs = [f for f in inputs if f.suffix.lower() != ".pdf"]
    others = [f for f in inputs if f.suffix.lower() not in IMAGE_EXTS and f.suffix.lower() != ".pdf"]
    if others:
        log(f"[警告] 以下文件格式不支持，已跳过：{[f.name for f in others]}")
        imgs = [f for f in imgs if f not in others]

    all_entries: list[dict] = []
    source_names: list[str] = []

    # 先处理 PDF，再处理图片
    for pdf in pdfs:
        entries, _ = build_from_pdf(
            pdf, pages_dir, args.dpi, args.max_width, start_index=len(all_entries)
        )
        all_entries.extend(entries)
        source_names.append(pdf.name)

    if imgs:
        entries = build_from_images(imgs, pages_dir, start_index=len(all_entries))
        all_entries.extend(entries)
        source_names.extend(f.name for f in imgs)

    if not all_entries:
        log("[错误] 没有生成任何页面。")
        return 1

    title = args.title or (Path(source_names[0]).stem if len(source_names) == 1 else "古籍")

    source_desc = (
        source_names[0] if len(source_names) == 1 else f"{len(source_names)} 个文件"
    )

    manifest_path = data_dir / "manifest.json"
    manifest = write_manifest(
        manifest_path, all_entries, title, args.direction, source_desc
    )

    # 命令行输出
    order = manifest["readingOrder"]
    log("")
    log("=== 构建完成 ===")
    log(f"  书名     : {title}")
    log(f"  页面总数 : {manifest['pageCount']}")
    log(f"  装帧方向 : {args.direction}")
    log(f"  阅读顺序 : {order[:8]}{' ...' if len(order) > 8 else ''}")
    log(f"  数据目录 : {data_dir}")
    log(f"  阅读器   : {root / 'index.html'}")
    log("")
    if args.direction == "right-to-left":
        log("  页序说明 : 第 1 页排在最右侧，翻页时页面自右向左推进（右开本）。")
    log("")

    # 同时输出一份到 stdout，方便脚本调用方解析
    return 0


if __name__ == "__main__":
    sys.exit(main())
