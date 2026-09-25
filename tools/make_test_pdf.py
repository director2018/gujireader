#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成一份用于测试上传功能的 PDF（内嵌原始 PNG，保持无损）。"""

import pathlib
import pymupdf

HERE = pathlib.Path(__file__).resolve().parent
imgs = sorted((HERE / "demo-scan").glob("*.png"))

out = HERE / "demo-book.pdf"
doc = pymupdf.open()
for p in imgs:
    page = doc.new_page(width=595, height=842)
    page.insert_image(pymupdf.Rect(0, 0, 595, 842), filename=str(p))
# 默认保存是未压缩的，6 页原始像素会撑到 ~37MB；deflate 无损压缩后只有 1~2MB，
# 同样的像素、测试拖起来更快，也让仓库不必背着一个大文件。
doc.save(out, deflate=True, garbage=4)
doc.close()

print(f"已生成 {out.name}，共 {len(imgs)} 页，{out.stat().st_size:,} bytes")
