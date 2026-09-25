#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成一份「大书」测试 PDF，用来复现并验证「几十页后变空白」的 bug。

复现条件与用户场景一致：
  - 页数远大于 59（默认 80 页）
  - 每页内嵌一张大尺寸扫描图（用演示扫描件放大到 2400×3400 左右）
  - 内嵌原始 PNG，保持无损

用法：
  python tools/make_big_pdf.py            # 80 页
  python tools/make_big_pdf.py 120        # 自定义页数
"""

import pathlib
import sys

import pymupdf  # PyMuPDF

HERE = pathlib.Path(__file__).resolve().parent
SRC = sorted((HERE / "demo-scan").glob("*.png"))

pages = int(sys.argv[1]) if len(sys.argv) > 1 else 80
out = HERE / f"big-book-{pages}.pdf"

if not SRC:
    raise SystemExit("缺少 tools/demo-scan/*.png，先运行 make_demo_scan.py")

doc = pymupdf.open()
for i in range(pages):
    # 复用演示扫描件，循环取用；每页都是真实的大图，逼迫浏览器处理高分辨率数据
    img = SRC[i % len(SRC)]
    # A4 点尺寸，但插入高分辨率图（约 300 DPI 对应的像素量）
    W, H = 595, 842
    page = doc.new_page(width=W, height=H)
    page.insert_image(pymupdf.Rect(0, 0, W, H), filename=str(img))

doc.save(out, deflate=True)
doc.close()

size = out.stat().st_size
print(f"已生成 {out.name}：{pages} 页，{size:,} bytes（{size/1048576:.1f} MB）")
