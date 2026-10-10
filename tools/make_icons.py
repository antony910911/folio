"""產生 Folio 的 App 圖示，和 Beamup、Mothership 同一個風格：
星空背景（Folio 是深墨水藍）中間一本像素筆記本，左頁寫滿了字，一支鉛筆正在右頁寫字。

用法：python3 tools/make_icons.py [book|beam]（需要 Pillow）
  book（預設）：只有筆記本和鉛筆
  beam：上面多一台 Beamup 的小飛碟，把光束打在筆記本上
輸出：icons/apple-touch-icon.png、icon-192.png、icon-512.png、icon-maskable-512.png
"""
import math
import random
import sys
from PIL import Image, ImageChops, ImageDraw, ImageFilter

S = 1024

# 像素筆記本：P 紙、L 橫線、I 手寫的字、B 書背的陰影、C 封面、D 封面暗部、E 頁緣
BOOK = [
    '.PPPPPPPPP.PPPPPPPPP.',
    'PPPPPPPPPPBPPPPPPPPPE',
    'PIIIIIIPPPBPLLLLLLLPE',
    'PPPPPPPPPPBPPPPPPPPPE',
    'PIIIIPIIPPBPLLLLLLLPE',
    'PPPPPPPPPPBPPPPPPPPPE',
    'PIIIIIPPPPBPLLLLLLLPE',
    'PPPPPPPPPPBPPPPPPPPPE',
    'PIIIPPPPPPBPPPPPPPPPE',
    'CCCCCCCCCCDCCCCCCCCCC',
    '.DDDDDDDDDDDDDDDDDDD.',
]
COL = {
    'P': (247, 243, 232), 'L': (176, 198, 236), 'I': (38, 52, 92), 'B': (206, 200, 186),
    'E': (222, 216, 200), 'C': (64, 104, 214), 'D': (40, 70, 160),
}

# Beamup 的小飛碟（beam 版用）
UFO = [
    '....GGGGG....',
    '...GGWGGGG...',
    '.TSSSSSSSSST.',
    'SSYSSSYSSSYSS',
    '.TTTTTTTTTTT.',
]
UFO_COL = {
    'G': (150, 220, 255), 'W': (255, 255, 255), 'S': (214, 218, 230),
    'T': (140, 146, 168), 'Y': (255, 214, 10),
}


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * max(0, min(1, t))) for i in range(3))


def background():
    img = Image.new('RGB', (S, S))
    px = img.load()
    # 墨水藍：Beamup 是紫色、Mothership 是石墨灰，Folio 用 App 本身的藍
    top, mid, bottom = (52, 88, 196), (24, 44, 112), (8, 14, 40)
    cx, cy = S * 0.5, S * 0.45
    for y in range(S):
        for x in range(S):
            t = min(1, math.hypot(x - cx, y - cy) / (S * 0.8))
            px[x, y] = lerp(top, mid, t / 0.5) if t < 0.5 else lerp(mid, bottom, (t - 0.5) / 0.5)
    return img


def cells(draw, rows, ox, oy, u, fill=None, palette=COL):
    for r, row in enumerate(rows):
        for c, ch in enumerate(row):
            if ch != '.':
                x, y = ox + c * u, oy + r * u
                draw.rectangle([round(x), round(y), round(x + u) - 1, round(y + u) - 1], fill=fill or palette[ch])


def pencil_cells(col0, row0, length):
    """斜放的鉛筆（筆尖在左下），回傳 [(col, row, color)]，以格子為單位。"""
    out = []
    for i in range(length):
        t = i / (length - 1)
        if t < 0.1:
            color, shade = (52, 52, 60), (52, 52, 60)         # 筆芯
        elif t < 0.24:
            color, shade = (240, 206, 160), (214, 176, 128)   # 削開的木頭
        elif t < 0.8:
            color, shade = (255, 196, 40), (226, 150, 20)     # 黃色筆身
        elif t < 0.87:
            color, shade = (206, 210, 222), (150, 156, 176)   # 金屬圈
        else:
            color, shade = (244, 140, 160), (214, 100, 126)   # 橡皮擦
        c, r = col0 + i, row0 - i
        out.append((c, r, color))
        if t >= 0.1:
            out.append((c + 1, r, shade))  # 兩格粗，右邊暗一點有立體感
        if t >= 0.24:
            out.append((c, r - 1, color))
    return out


def render(scale=1.0, variant='book'):
    img = background()
    grid = S / 32  # 星星對齊的像素格

    u = S * 0.66 * scale / len(BOOK[0])
    w, h = len(BOOK[0]) * u, len(BOOK) * u
    ox = (S - w) / 2
    oy = (S - h) / 2 + (S * 0.09 if variant == 'beam' else S * 0.02)

    # 像素星星：小方塊＋四顆十字閃光（和 Beamup、Mothership 一樣的排法）
    rnd = random.Random(23)
    d = ImageDraw.Draw(img)
    for _ in range(30):
        x, y = rnd.randrange(0, 32) * grid, rnd.randrange(0, 32) * grid
        if ox - u * 2 < x < ox + w + u * 3 and oy - u * (9 if variant == 'beam' else 6) < y < oy + h + u:
            continue  # 主角周圍留乾淨
        a = rnd.choice([120, 170, 230])
        d.rectangle([x, y, x + grid / 2 - 1, y + grid / 2 - 1], fill=(a - 10, a, min(255, a + 30)))
    for cx, cy in [(4, 6), (27, 5), (27, 27), (4, 26)]:
        x, y = cx * grid, cy * grid
        for dx, dy in [(0, 0), (-1, 0), (1, 0), (0, -1), (0, 1)]:
            hh = grid / 2
            d.rectangle([x + dx * hh, y + dy * hh, x + dx * hh + hh - 1, y + dy * hh + hh - 1], fill=(255, 236, 160))

    pencil = pencil_cells(14.2, 7.2, 9)

    if variant == 'beam':
        # 飛碟在筆記本上方，光束打在書頁上
        uu = u * 0.62
        uw = len(UFO[0]) * uu
        ux, uy = (S - uw) / 2, oy - u * 7.2
        beam = Image.new('RGB', (S, S), (0, 0, 0))
        bd = ImageDraw.Draw(beam)
        rows = 7
        top_y = uy + len(UFO) * uu
        bottom_y = oy + u * 0.5
        step = (bottom_y - top_y) / rows
        for r in range(rows):
            half = uw * (0.2 + r * 0.045)
            k = 0.35 + 0.65 * (r / (rows - 1))
            bd.rectangle([round(S / 2 - half), round(top_y + r * step), round(S / 2 + half), round(top_y + (r + 1) * step) - 1],
                         fill=lerp((0, 0, 0), (150, 128, 52), k * 0.8))
        img = ImageChops.screen(img, beam)

    # 背後的光暈
    glow = Image.new('RGB', (S, S), (0, 0, 0))
    gd = ImageDraw.Draw(glow)
    cells(gd, BOOK, ox, oy, u, fill=(110, 130, 220))
    img = ImageChops.screen(img, glow.filter(ImageFilter.GaussianBlur(60 * scale)))
    if variant == 'beam':
        lights = Image.new('RGB', (S, S), (0, 0, 0))
        cells(ImageDraw.Draw(lights), [''.join(ch if ch == 'Y' else '.' for ch in r) for r in UFO], ux, uy, uu, fill=(255, 170, 40))
        img = ImageChops.screen(img, lights.filter(ImageFilter.GaussianBlur(24 * scale)))

    # 陰影讓東西浮起來
    shadow = Image.new('L', (S, S), 0)
    sd = ImageDraw.Draw(shadow)
    cells(sd, BOOK, ox + u * 0.35, oy + u * 0.45, u, fill=150)
    for c, r, _ in pencil:
        x, y = ox + c * u + u * 0.35, oy + r * u + u * 0.45
        sd.rectangle([round(x), round(y), round(x + u) - 1, round(y + u) - 1], fill=150)
    if variant == 'beam':
        cells(sd, UFO, ux + uu * 0.35, uy + uu * 0.45, uu, fill=150)
    img = Image.composite(Image.new('RGB', (S, S), (6, 10, 30)), img, shadow)

    d = ImageDraw.Draw(img)
    cells(d, BOOK, ox, oy, u)
    for c, r, color in pencil:
        x, y = ox + c * u, oy + r * u
        d.rectangle([round(x), round(y), round(x + u) - 1, round(y + u) - 1], fill=color)
    # 鉛筆剛寫下的一小段字
    for c in (12, 13):
        x, y = ox + c * u, oy + 8 * u
        d.rectangle([round(x), round(y + u * 0.3), round(x + u) - 1, round(y + u * 0.7)], fill=COL['I'])
    if variant == 'beam':
        cells(d, UFO, ux, uy, uu, palette=UFO_COL)
    return img


if __name__ == '__main__':
    variant = sys.argv[1] if len(sys.argv) > 1 else 'book'
    full = render(1.0, variant)
    for size, name in [(180, 'apple-touch-icon.png'), (192, 'icon-192.png'), (512, 'icon-512.png')]:
        full.resize((size, size), Image.LANCZOS).save(f'icons/{name}', optimize=True)
    # Android 的 maskable 圖示會被裁成圓形，內容縮小一點留安全邊
    render(0.8, variant).resize((512, 512), Image.LANCZOS).save('icons/icon-maskable-512.png', optimize=True)
    print('ok')
