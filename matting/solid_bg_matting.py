# -*- coding: utf-8 -*-
"""
matting/solid_bg_matting.py —— 纯色背景生图抠图验证与工具

两种方法,输出透明 PNG 供对比:
  chroma  色键法:与背景色的色距 + 边框连通性(主体内部的相近色不会被误抠)+ 边缘按色距羽化。
          确定性、零依赖(cv2/numpy),适合边缘干净的卡通素材;背景色与主体色差越大越稳。
  sam2    SAM2 点提示分割(主体居中构图适用)→ 可选 --vitmatte 用 ViTMatte 按 trimap 精修 alpha,
          毛边/毛发类复杂边缘最精细(需本机已有 sam2 环境+权重)。

用法:
  python solid_bg_matting.py <图片> <输出目录> [--method chroma|sam2|both]
       [--bg auto | R,G,B] [--sam2-ckpt <sam2.1_hiera_small.pt路径>] [--vitmatte]
       [--model <hf vitmatte模型名,默认 hustvl/vitmatte-small-composition-1k>]

提示:若需要 SAM2/ViTMatte,用装好 torch+sam2+transformers 的 Python 环境运行;
     色键法任何装了 cv2 的环境都能跑。
"""
import argparse
import os
from pathlib import Path

import cv2
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


# ---------- 方法一:色键(边框连通 + 色距羽化) ----------
def chroma_key(img_rgb, bg_rgb=None, tol=42.0):
    h, w = img_rgb.shape[:2]
    if bg_rgb is None:
        corners = np.stack([img_rgb[3, 3], img_rgb[3, -4], img_rgb[-4, 3], img_rgb[-4, -4]]).astype(np.float32)
        bg_rgb = corners.mean(axis=0)
        print(f"  [chroma] 自动探测背景色 RGB=({bg_rgb[0]:.0f},{bg_rgb[1]:.0f},{bg_rgb[2]:.0f})")
    bg = np.array(bg_rgb, dtype=np.float32)
    dist = np.linalg.norm(img_rgb.astype(np.float32) - bg, axis=2)

    near_bg = (dist <= tol).astype(np.uint8) * 255
    num, labels = cv2.connectedComponents(near_bg, connectivity=4)
    border = set(labels[0, :]) | set(labels[-1, :]) | set(labels[:, 0]) | set(labels[:, -1])
    border.discard(0)
    bg_region = np.isin(labels, list(border))

    alpha = np.full((h, w), 255.0)
    alpha[bg_region] = 0.0
    unknown = (~bg_region) & (dist > tol)
    soft = np.clip((dist - tol) / max(tol * 0.8, 1) * 255, 0, 255)  # 离背景越远越实
    alpha[unknown] = soft[unknown]
    alpha = cv2.GaussianBlur(alpha, (3, 3), 0)
    return alpha.astype(np.uint8)


# ---------- 方法二:SAM2 点提示(+可选 ViTMatte 精修) ----------
def sam2_mask(img_rgb, ckpt, device="cuda"):
    from sam2.build_sam import build_sam2
    from sam2.sam2_image_predictor import SAM2ImagePredictor

    h, w = img_rgb.shape[:2]
    predictor = SAM2ImagePredictor(
        build_sam2("configs/sam2.1/sam2.1_hiera_s.yaml", ckpt, device=device)
    )
    predictor.set_image(img_rgb)
    # 点必须都落在主体上:居中构图取中心+四向中带点,外加底部一点保住贴边爪/底座;
    # box 给出主体大致范围,防止 mask 泄漏到背景(实测 3×3 网格会打到背景点反而劣化)
    h, w = img_rgb.shape[:2]
    pts = [
        (0.50, 0.45), (0.50, 0.25), (0.50, 0.70), (0.32, 0.50), (0.68, 0.50), (0.50, 0.92),
    ]
    masks, scores, _ = predictor.predict(
        point_coords=np.array([(x * w, y * h) for x, y in pts]),
        point_labels=np.ones(len(pts)),
        box=np.array([[0.06 * w, 0.04 * h, 0.94 * w, 0.97 * h]]),
        multimask_output=False,
    )
    print(f"  [sam2] 最高分 {scores.max():.3f}")
    return masks[0]


def vitmatte_alpha(img_rgb, mask, model_name):
    import torch
    from transformers import VitMatteForImageMatting, VitMatteImageProcessor

    h, w = mask.shape
    sure_fg = cv2.erode(mask, np.ones((15, 15), np.uint8))
    sure_bg = cv2.dilate(255 - mask, np.ones((25, 25), np.uint8))
    trimap = np.full((h, w), 128, np.uint8)
    trimap[sure_fg > 0] = 255
    trimap[sure_bg > 0] = 0

    model = VitMatteForImageMatting.from_pretrained(model_name)
    proc = VitMatteImageProcessor.from_pretrained(model_name)
    with torch.no_grad():
        inputs = proc(images=Image.fromarray(img_rgb), trimaps=Image.fromarray(trimap), return_tensors="pt")
        alphas = model(**inputs).alphas[0, 0].numpy()
    return (np.clip(alphas, 0, 1) * 255).astype(np.uint8)


# ---------- 方法三:BEN2(全自动,置信度引导抠图,MIT) ----------
def ben2_alpha(img_rgb, weights):
    import sys
    import torch
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from BEN2 import BEN_Base
    from safetensors.torch import load_file

    model = BEN_Base()
    p = Path(weights)
    if p.suffix == ".safetensors":
        model.load_state_dict(load_file(str(p)), strict=True)  # 官方 loadcheckpoints 只认 .pth,这里直接映射 safetensors
    else:
        model.loadcheckpoints(str(p))
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model.to(device).eval()
    with torch.no_grad():
        pil = Image.fromarray(img_rgb)
        out = model.inference(pil)  # 返回 list[PIL RGBA]
    rgba = out[0] if isinstance(out, list) else out
    return np.array(rgba.getchannel("A"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("outdir")
    ap.add_argument("--method", default="both", choices=["chroma", "sam2", "ben2", "both", "all"])
    ap.add_argument("--bg", default="auto", help="auto=四角均色,或 R,G,B")
    ap.add_argument("--sam2-ckpt", default=os.environ.get("SAM2_CHECKPOINT", ""))
    ap.add_argument("--ben2-weights", default=os.environ.get("BEN2_WEIGHTS", ""), help="BEN2_Base.safetensors 或 .pth 路径")
    ap.add_argument("--vitmatte", action="store_true", help="SAM2 mask 后用 ViTMatte 精修 alpha")
    ap.add_argument("--model", default="hustvl/vitmatte-small-composition-1k")
    ap.add_argument("--device", default="cuda" if os.environ.get("FORCE_CPU", "") != "1" else "cpu")
    args = ap.parse_args()

    img_p = Path(args.image)
    out = Path(args.outdir)
    out.mkdir(parents=True, exist_ok=True)
    img_rgb = np.array(Image.open(img_p).convert("RGB"))
    h, w = img_rgb.shape[:2]
    bg_rgb = None if args.bg == "auto" else np.array([int(x) for x in args.bg.split(",")], dtype=np.float32)
    stem = img_p.stem

    results = {}
    if args.method in ("chroma", "both", "all"):
        results["chroma"] = chroma_key(img_rgb, bg_rgb)
    if args.method in ("sam2", "both", "all"):
        if not args.sam2_ckpt:
            raise SystemExit("sam2 方法需要 --sam2-ckpt 或环境变量 SAM2_CHECKPOINT")
        mask = (sam2_mask(img_rgb, args.sam2_ckpt, args.device) * 255).astype(np.uint8)
        if args.vitmatte:
            try:
                results["sam2+vitmatte"] = vitmatte_alpha(img_rgb, mask, args.model)
            except Exception as e:
                print(f"  [vitmatte] 精修失败({e}),退回 SAM2 mask 羽化")
        if "sam2+vitmatte" not in results:
            results["sam2"] = cv2.GaussianBlur(mask, (3, 3), 0)
    if args.method in ("ben2", "all"):
        if not args.ben2_weights:
            raise SystemExit("ben2 方法需要 --ben2-weights 或环境变量 BEN2_WEIGHTS")
        results["ben2"] = ben2_alpha(img_rgb, args.ben2_weights)

    panels = [img_rgb.copy()]
    names = ["original"]
    for name, alpha in results.items():
        rgba = np.dstack([img_rgb, alpha])
        Image.fromarray(rgba, "RGBA").save(out / f"{stem}_{name}.png")
        panels.append(on_checker(rgba))
        names.append(name)
        edge = int(((alpha > 8) & (alpha < 247)).sum())
        print(f"  ✓ {stem}_{name}.png | 半透明边缘像素 {edge} 个")

    gap = np.full((h, 6, 3), 255, np.uint8)
    strip = panels[0]
    for p in panels[1:]:
        strip = np.hstack([strip, gap, p])
    tag = "_".join(results.keys())
    Image.fromarray(strip).save(out / f"{stem}_compare_{tag}.png")
    print(f"  ✓ {stem}_compare_{tag}.png(棋盘格对比图)")


if __name__ == "__main__":
    main()
