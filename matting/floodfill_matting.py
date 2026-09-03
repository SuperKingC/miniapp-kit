# -*- coding: utf-8 -*-
"""
matting/floodfill_matting.py —— 边缘泛洪去背(实验方法,零 cv2/scipy 依赖,纯 numpy+PIL)

原理:与背景色距 ≤ 容差的像素中,只移除与画布边框四连通的区域;主体内部的背景近色
(白胸/白爪等)只要外轮廓描边封闭就不会被波及。边缘带按色距做软过渡,避免硬边锯齿。

与 solid_bg_matting.py 的关系:同源思路(色键=固定容差+边框连通)的零依赖实现,定位为
实验对比与无 cv2 环境的兜底;不改默认链路(BEN2 首选 / SAM2 兜底 / 色键粗筛)。
背景必须是纯色平涂(无渐变无阴影),主体色板里不要混入与背景相同的颜色;同一路径换图
记得升文件名防缓存。

用法:
  python floodfill_matting.py <图片> <输出目录> [--tol 42] [--bg auto|R,G,B] [--no-compare]

输出(输出目录下,自动建 floodfill 子目录):
  <name>_floodfill.png           透明 PNG
  <name>_floodfill_compare.png   原图 | 棋盘格预览 并排对比
"""
import argparse
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image


def checkerboard(w, h, cell=16):
    yy, xx = np.mgrid[0:h, 0:w]
    board = (((yy // cell) + (xx // cell)) % 2 * 40 + 200).astype(np.uint8)
    return np.dstack([board] * 3)


def on_checker(img_rgba):
    h, w = img_rgba.shape[:2]
    board = checkerboard(w, h).astype(np.float32)
    a = img_rgba[:, :, 3:4].astype(np.float32) / 255
    return (img_rgba[:, :, :3].astype(np.float32) * a + board * (1 - a)).astype(np.uint8)


def shift(m, dy, dx):
    """布尔图按 (dy,dx) 平移,越界补 False(np.roll 会回绕,不能用)。"""
    h, w = m.shape
    p = np.pad(m, 1, constant_values=False)
    return p[1 + dy:1 + dy + h, 1 + dx:1 + dx + w]


def floodfill_bg_mask(rgb, bg_rgb, tol):
    """边框连通的背景区域掩码:frontier BFS,等效 connectedComponents 边框过滤。"""
    dist = np.linalg.norm(rgb.astype(np.float32) - np.array(bg_rgb, np.float32), axis=2)
    near = dist <= tol
    visited = np.zeros(rgb.shape[:2], bool)
    frontier = np.zeros_like(visited)
    frontier[0, :] = frontier[-1, :] = frontier[:, 0] = frontier[:, -1] = True
    frontier &= near
    visited |= frontier
    while frontier.any():
        neigh = (shift(frontier, 1, 0) | shift(frontier, -1, 0) |
                 shift(frontier, 0, 1) | shift(frontier, 0, -1))
        frontier = neigh & near & ~visited
        visited |= frontier
    return visited, dist


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('image')
    ap.add_argument('outdir')
    ap.add_argument('--tol', type=float, default=42.0, help='与背景色的色距容差,默认 42')
    ap.add_argument('--bg', default='auto', help='auto 取四角均值,或 R,G,B')
    ap.add_argument('--no-compare', action='store_true', help='不输出对比图')
    args = ap.parse_args()

    src = Path(args.image)
    if not src.exists():
        sys.exit(f'[floodfill] 图片不存在: {src}')
    outdir = Path(args.outdir) / 'floodfill'
    outdir.mkdir(parents=True, exist_ok=True)

    img = Image.open(src).convert('RGB')
    rgb = np.asarray(img)
    h, w = rgb.shape[:2]

    if args.bg == 'auto':
        corners = np.stack([rgb[3, 3], rgb[3, -4], rgb[-4, 3], rgb[-4, -4]]).astype(np.float32)
        bg = corners.mean(axis=0)
        print(f'[floodfill] 自动背景色 RGB=({bg[0]:.0f},{bg[1]:.0f},{bg[2]:.0f})')
    else:
        bg = np.array([int(v) for v in args.bg.split(',')], np.float32)

    bg_region, dist = floodfill_bg_mask(rgb, bg, args.tol)
    removed_pct = 100 * bg_region.sum() / (h * w)
    print(f'[floodfill] 移除边框连通背景 {removed_pct:.1f}% ({h}x{w}, tol={args.tol})')
    if removed_pct < 5:
        print('[floodfill] 警告:移除占比过低,背景可能不是纯色平涂(渐变/纹理/假棋盘格过密),加大 --tol 或换底重生成')

    # 边缘软过渡:仅对与背景区相邻的主体像素,按色距线性给 alpha
    bg_soft = shift(bg_region, 1, 0) | shift(bg_region, -1, 0) | shift(bg_region, 0, 1) | shift(bg_region, 0, -1)
    edge_band = bg_soft & ~bg_region
    alpha = np.full((h, w), 255.0)
    alpha[bg_region] = 0.0
    feather = max(args.tol * 0.8, 1.0)
    alpha[edge_band] = np.clip((dist[edge_band] - args.tol) / feather, 0, 1) * 255

    rgba = np.dstack([rgb, alpha.astype(np.uint8)])
    out_png = outdir / f'{src.stem}_floodfill.png'
    Image.fromarray(rgba, 'RGBA').save(out_png)

    preview = on_checker(rgba)
    if not args.no_compare:
        gap = np.full((h, 16, 3), 255, np.uint8)
        sheet = np.concatenate([rgb, gap, preview[:, :, :3]], axis=1)
        Image.fromarray(sheet).save(outdir / f'{src.stem}_floodfill_compare.png')

    size_kb = out_png.stat().st_size / 1024
    print(f'[floodfill] ✓ {out_png} ({size_kb:.0f}KB){"" if args.no_compare else f" + 对比图 {src.stem}_floodfill_compare.png"}')


if __name__ == '__main__':
    main()
