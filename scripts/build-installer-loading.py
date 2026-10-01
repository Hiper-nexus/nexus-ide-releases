#!/usr/bin/env python3
"""Gera `assets/installer-loading.gif` (268×167), a tela "Preparando seu ambiente"
do instalador Squirrel do Windows, com a marca atual do app (o "N" pixel rosa).

O ícone vem de `assets/icon.png`, então a tela acompanha o ícone do app. Rode
`node scripts/build-app-icon-source.mjs` antes se o ícone mudou:

    python3 scripts/build-installer-loading.py

Requer Pillow e as fontes Arial do macOS (a imagem é estática e versionada no repo).
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
INK, SURFACE, LINE = (8, 7, 9), (17, 16, 19), (42, 37, 48)
PINK, MUTED, FAINT = (255, 79, 139), (170, 162, 168), (146, 139, 144)
WHITE = (250, 247, 249)
W, H, SCALE = 268, 167, 4  # desenha em 4× e reduz: bordas e texto sem serrilhado

FONTS = "/System/Library/Fonts/Supplemental"
bold = lambda px: ImageFont.truetype(f"{FONTS}/Arial Bold.ttf", px * SCALE)
regular = lambda px: ImageFont.truetype(f"{FONTS}/Arial.ttf", px * SCALE)


def main():
    canvas = Image.new("RGB", (W * SCALE, H * SCALE), INK)
    draw = ImageDraw.Draw(canvas)
    draw.rectangle([0, 0, W * SCALE - 1, H * SCALE - 1], outline=LINE, width=SCALE)

    icon = Image.open(ROOT / "assets" / "icon.png").convert("RGBA")
    size = 100 * SCALE
    icon = icon.resize((size, size), Image.LANCZOS)
    canvas.paste(icon, (10 * SCALE, 31 * SCALE), icon)

    draw.text((116 * SCALE, 46 * SCALE), "NexusIDE", font=bold(22), fill=WHITE)
    draw.text((116 * SCALE, 82 * SCALE), "Preparando seu ambiente", font=regular(12), fill=PINK)
    draw.text((116 * SCALE, 104 * SCALE), "Aguarde um instante...", font=regular(12), fill=MUTED)

    draw.line([(12 * SCALE, 133 * SCALE), ((W - 12) * SCALE, 133 * SCALE)], fill=LINE, width=SCALE)
    draw.text((14 * SCALE, 142 * SCALE), "Nexus • desenvolvimento com IA", font=regular(10), fill=FAINT)

    final = canvas.resize((W, H), Image.LANCZOS).convert("P", palette=Image.ADAPTIVE, colors=64)
    target = ROOT / "assets" / "installer-loading.gif"
    final.save(target, format="GIF", optimize=True)
    print(f"[installer] {target} escrito — {W}×{H}, {target.stat().st_size} bytes")


if __name__ == "__main__":
    main()
