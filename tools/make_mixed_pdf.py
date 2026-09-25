"""生成两份用于翻书「跨」验证的小 PDF：

  mixed-book.pdf  6 页：单、单、对开、单、单、单
                  —— 期望切跨为 [1,2] [3] [4,5] [6]
  one-page.pdf    1 页：整张居中

用法： python make_mixed_pdf.py
"""
from pathlib import Path

import fitz

HERE = Path(__file__).parent


def add(doc, w, h, label):
    page = doc.new_page(width=w, height=h)
    page.draw_rect(fitz.Rect(20, 20, w - 20, h - 20), color=(0.25, 0.2, 0.15), width=2)
    page.insert_text((w / 2 - 70, h / 2), label, fontsize=30)
    return page


def build(path, pages):
    doc = fitz.open()
    for w, h, label in pages:
        add(doc, w, h, label)
    doc.save(path)
    print("saved", path.name, path.stat().st_size, "bytes", len(doc), "pages")
    doc.close()


SINGLE = (595, 842)          # 单页扫描：竖长条，宽高比 0.71
SPREAD = (1190, 842)         # 对开扫描：一页里印着左右两面，宽高比 1.41

build(HERE / "mixed-book.pdf", [
    (*SINGLE, "P1 single"),
    (*SINGLE, "P2 single"),
    (*SPREAD, "P3 spread (two faces)"),
    (*SINGLE, "P4 single"),
    (*SINGLE, "P5 single"),
    (*SINGLE, "P6 single"),
])

build(HERE / "one-page.pdf", [(*SINGLE, "P1 only")])
