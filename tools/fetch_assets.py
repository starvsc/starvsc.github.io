#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
离线资源下载脚本(fetch_assets.py)
==================================
在“有网络的电脑”上运行一次,把浏览器端人脸关键点推理所需的
face-api 库与模型权重下载到本项目的 assets/ 目录,
之后可在无外网环境(答辩/演示)运行。

用法:
    python fetch_assets.py            # 在当前项目根目录执行
    python fetch_assets.py --base .   # 显式指定项目根目录

下载来源(jsdelivr CDN,与 js/config.js 中 CDN 兜底地址一致):
    @vladmandic/face-api@1.7.13
"""
import argparse
import json
import pathlib
import sys
import urllib.request

VERSION = "1.7.13"
CDN = f"https://cdn.jsdelivr.net/npm/@vladmandic/face-api@{VERSION}"

# 需要的人脸网络(仅加载这些即够:人脸检测 + 68 点关键点)
MODELS = [
    "tiny_face_detector_model",
    "face_landmark_68_model",
]

LIB_SRC = f"{CDN}/dist/face-api.js"
LIB_DST_NAME = "face-api.min.js"  # 与 js/config.js 本地路径对应

HEADERS = {"User-Agent": "fetch_assets/1.0"}


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def download_to(url: str, dst: pathlib.Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists() and dst.stat().st_size > 0:
        print(f"  · 已存在,跳过: {dst.name}")
        return
    print(f"  ↓ {url}")
    data = fetch(url)
    dst.write_bytes(data)
    print(f"  ✓ {dst} ({len(data) / 1024:.0f} KB)")


def main() -> int:
    ap = argparse.ArgumentParser(description="下载 face-api 库与关键点模型到本地 assets/")
    ap.add_argument("--base", default=".", help="项目根目录(默认当前目录)")
    args = ap.parse_args()

    base = pathlib.Path(args.base).resolve()
    models_dir = base / "assets" / "models"
    vendor_dir = base / "assets" / "vendor"

    print(f"[1/2] 下载 face-api 库 -> {vendor_dir}")
    download_to(LIB_SRC, vendor_dir / LIB_DST_NAME)

    print("[2/2] 下载关键点模型 ->", models_dir)
    for name in MODELS:
        manifest_url = f"{CDN}/model/{name}-weights_manifest.json"
        try:
            manifest = json.loads(fetch(manifest_url))
        except Exception as e:  # noqa: BLE001
            print(f"  ! 读取 {name} 清单失败: {e}")
            return 1
        # 下载清单本身
        download_to(manifest_url, models_dir / f"{name}-weights_manifest.json")
        # 清单中列出的权重文件(可能是单 bin,也可能是分片 shardN)
        # 注意:@vladmandic/face-api 的清单顶层是数组,每项含 paths
        for entry in manifest:
            for p in entry.get("paths", []):
                download_to(f"{CDN}/model/{p}", models_dir / p)

    print("\n完成。现在 js/config.js 会自动优先使用本地 assets/,可在离线环境运行。")
    print("提示:若变更了 face-api 版本,请同步修改 js/config.js 与脚本中的 VERSION。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
