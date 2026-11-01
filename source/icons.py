"""Draws the home-screen icons into ../icons. Run: python3 source/icons.py (needs Pillow)."""
import pathlib
from PIL import Image, ImageDraw, ImageFilter
OUT = pathlib.Path(__file__).resolve().parent.parent / 'icons'
S = 1024
def art(scale=1.0):
    im = Image.new('RGB', (S, S), (29, 34, 37))
    layer = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    c = S / 2
    def Y(v): return c + (v - c) * scale
    def X(v): return c + (v - c) * scale
    top, bot, slit = 330, 694, 640
    # the developed strip: stylised sky, hills, fields, platform
    bands = [(0.00, (111, 147, 189)), (0.22, (169, 192, 212)), (0.40, (142, 159, 188)), (0.47, (111, 133, 128)),
             (0.56, (154, 171, 90)), (0.66, (127, 154, 79)), (0.74, (168, 166, 158)), (0.90, (240, 196, 25)), (0.935, (232, 227, 214)), (0.965, (133, 123, 109))]
    for i, (f, col) in enumerate(bands):
        f2 = bands[i + 1][0] if i + 1 < len(bands) else 1.0
        d.rectangle([X(0), Y(top + f * (bot - top)), X(slit), Y(top + f2 * (bot - top))], fill=col + (255,))
    # a few uprights in the strip, like the poles a train passes
    for px in (120, 300, 470):
        d.rectangle([X(px), Y(top + 0.08 * (bot - top)), X(px + 9), Y(top + 0.9 * (bot - top))], fill=(70, 78, 86, 255))
    # unscanned rest of the frame
    d.rectangle([X(slit), Y(top), X(S), Y(bot)], fill=(18, 22, 24, 255))
    im.paste(layer, (0, 0), layer)
    glow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.rectangle([X(slit - 14), Y(240), X(slit + 14), Y(784)], fill=(240, 191, 39, 200))
    glow = glow.filter(ImageFilter.GaussianBlur(26 * scale))
    im.paste(glow, (0, 0), glow)
    d2 = ImageDraw.Draw(im)
    d2.rectangle([X(slit - 9), Y(240), X(slit + 9), Y(784)], fill=(240, 191, 39))
    return im
full = art(1.0)
for name, size in [('apple-touch-icon.png', 180), ('icon-192.png', 192), ('icon-512.png', 512)]:
    full.resize((size, size), Image.LANCZOS).save(OUT / name)
art(0.78).resize((512, 512), Image.LANCZOS).save(OUT / 'icon-maskable-512.png')
full.resize((64, 64), Image.LANCZOS).save(OUT / 'favicon-64.png')
