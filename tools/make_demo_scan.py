#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成演示用的「古籍竖排扫描页」图片。

目的：在没有真实扫描件的情况下，验证阅读器的
  1) 右开本逆序页序是否正确
  2) 竖排从右向左的版式效果
  3) 左右按钮翻页是否顺畅

真实场景请直接用自己的 PDF / 扫描图。
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


W, H = 1240, 1754          # 接近 A4 300dpi 的观感
MARGIN_X = 96
MARGIN_Y = 110
BG = (238, 231, 214)        # 仿古纸色
INK = (38, 32, 24)
FRAME = (150, 134, 106)
RED = (150, 52, 40)


def pick_font(size: int, bold: bool = False):
    """挑一个能渲染中文的字体。"""
    cands = [
        r"C:\Windows\Fonts\STSONG.TTF",
        r"C:\Windows\Fonts\simsun.ttc",
        r"C:\Windows\Fonts\msyh.ttc",
        r"C:\Windows\Fonts\msyhbd.ttc" if bold else r"C:\Windows\Fonts\simkai.ttf",
        r"C:\Windows\Fonts\simhei.ttf",
        r"C:\Windows\Fonts\Deng.ttf",
    ]
    for c in cands:
        p = Path(c)
        if p.exists():
            try:
                return ImageFont.truetype(str(p), size)
            except Exception:
                continue
    return ImageFont.load_default()


# 每页的正文（每行是竖排的一列，从右往左读）
PAGES = [
    {
        "head": "卷一 · 山川紀勝",
        "lines": [
            "古之善觀山水者",
            "不惟覽其形勝",
            "亦將求其所以然",
            "故登高必自卑",
            "涉遠必自邇",
            "循是以往",
            "可與言道矣",
        ],
    },
    {
        "head": "卷二 · 風土記",
        "lines": [
            "鄉之人有好古者",
            "藏書萬卷於樓中",
            "晨起而讀",
            "夜分而息",
            "如是者三十年",
            "未嘗一日廢也",
            "其志可謂專矣",
        ],
    },
    {
        "head": "卷三 · 藝文志",
        "lines": [
            "文章者經國之大業",
            "不朽之盛事",
            "年壽有時而盡",
            "榮樂止乎其身",
            "二者必至之常期",
            "未若文章之無窮",
            "是以古之作者",
        ],
    },
    {
        "head": "卷四 · 器物考",
        "lines": [
            "凡器物之製作",
            "必有法度存焉",
            "失其法度",
            "則雖工而不中於用",
            "匠人謹守其規",
            "不敢以意為之",
            "此所以能傳世也",
        ],
    },
    {
        "head": "卷五 · 雜記",
        "lines": [
            "世間奇聞異事",
            "多出於耳目之外",
            "然苟非親見",
            "未可遽信",
            "存疑以待後考",
            "此學者之慎也",
            "故錄其可信者",
        ],
    },
    {
        "head": "卷六 · 終篇",
        "lines": [
            "書成之日",
            "距始事之歲",
            "蓋十有八年矣",
            "其間風雨晦明",
            "人事代謝",
            "皆不足以易其志",
            "庶幾無愧於心",
        ],
    },
]


def draw_page(page_no: int, total: int, spec: dict) -> Image.Image:
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)

    # 纸张微纹理（极淡的噪点，模拟扫描纸纹）
    import random
    random.seed(page_no * 7919)
    px = im.load()
    for _ in range(int(W * H * 0.012)):
        x = random.randrange(W)
        y = random.randrange(H)
        r, g, b = px[x, y]
        n = random.randint(-9, 5)
        px[x, y] = (max(0, min(255, r + n)), max(0, min(255, g + n)), max(0, min(255, b + n)))

    # 版框（四周双线）
    d.rectangle([MARGIN_X - 30, MARGIN_Y - 34, W - MARGIN_X + 30, H - MARGIN_Y + 34],
                outline=FRAME, width=3)
    d.rectangle([MARGIN_X - 22, MARGIN_Y - 26, W - MARGIN_X + 22, H - MARGIN_Y + 26],
                outline=FRAME, width=1)

    # 书名在左侧（竖排书名题签的位置）
    f_small = pick_font(28)
    title = "古 籍 演 示 本"
    ty = MARGIN_Y + 10
    for ch in title:
        d.text((MARGIN_X - 74, ty), ch, font=f_small, fill=FRAME)
        ty += 34
    d.text((MARGIN_X - 74, ty + 24), f"卷之{page_no}", font=pick_font(24), fill=FRAME)

    # 版心：竖排正文，从右向左排列
    col_w = 74                                   # 列宽
    body_top = MARGIN_Y + 8
    f_body = pick_font(46)

    x = W - MARGIN_X - 30 - col_w
    for line in spec["lines"]:
        y = body_top
        for ch in line:
            d.text((x, y), ch, font=f_body, fill=INK)
            y += 56
        x -= col_w

    # 首行标目（大字，最右列）
    f_head = pick_font(38, bold=True)
    hx = W - MARGIN_X - 30 - col_w - col_w // 2 + 8
    hy = body_top + 6
    for ch in spec["head"]:
        d.text((hx, hy), ch, font=f_head, fill=RED)
        hy += 46

    # 页码（在版心下方居中）
    f_pg = pick_font(26)
    label = f"第 {page_no} 页 / 共 {total} 页"
    bb = d.textbbox((0, 0), label, font=f_pg)
    d.text(((W - (bb[2] - bb[0])) / 2, H - MARGIN_Y + 46), label, font=f_pg, fill=FRAME)

    # 扫描感的轻微污渍
    for _ in range(3):
        cx = random.randint(120, W - 120)
        cy = random.randint(120, H - 120)
        rr = random.randint(30, 90)
        for i in range(rr, 0, -6):
            a = int(6 * (1 - i / rr))
            d.ellipse([cx - i, cy - i, cx + i, cy + i], outline=(190, 178, 155))

    return im


def main():
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / "demo-scan"
    out.mkdir(parents=True, exist_ok=True)

    total = len(PAGES)
    for i, spec in enumerate(PAGES, start=1):
        im = draw_page(i, total, spec)
        p = out / f"scan_{i:03d}.png"
        im.save(p, format="PNG", optimize=True)
        print(f"  生成 {p.name}  {im.size[0]}x{im.size[1]}")

    print(f"\n共 {total} 页，输出目录：{out}")
    print("扫描顺序（从上到下）: scan_001 -> scan_006")


if __name__ == "__main__":
    main()
