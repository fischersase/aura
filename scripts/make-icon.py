"""Aura-Symbol: leuchtender Farbring (Aura) um einen hellen Kern. Erzeugt icon.png (512), icon.ico und tray.png."""
# Aufruf: python3 scripts/make-icon.py assets   (braucht Pillow)
import math, sys
from PIL import Image, ImageFilter

STOPS = [(0.00, (34, 211, 238)), (0.33, (139, 92, 246)), (0.66, (244, 114, 182)), (1.00, (34, 211, 238))]

def grad(t):
  for (a, ca), (b, cb) in zip(STOPS, STOPS[1:]):
    if t <= b:
      f = (t - a) / (b - a)
      return tuple(round(ca[i] + (cb[i] - ca[i]) * f) for i in range(3))
  return STOPS[-1][1]

def render(size, ring=0.30, width=0.085, glow=True, core=0.115):
  S = size * 4  # Supersampling
  img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
  px = img.load()
  c = S / 2
  for y in range(S):
    for x in range(S):
      dx, dy = (x - c) / S, (y - c) / S
      r = math.hypot(dx, dy)
      ang = (math.atan2(dy, dx) / (2 * math.pi) + 0.625) % 1.0
      d = abs(r - ring)
      a = 0.0
      if d <= width / 2:
        a = 1.0
      elif glow:
        a = 0.55 * math.exp(-((d - width / 2) / 0.05) ** 2)
      col = grad(ang)
      # heller Kern, leicht nach oben rechts versetzt
      kr = math.hypot(dx - 0.0, dy + 0.0)
      if kr <= core:
        k = 1 - (kr / core) ** 4
        col = tuple(round(255 * k + cc * (1 - k)) for cc in grad((ang + 0.5) % 1))
        a = max(a, 1.0)
      if a > 0:
        px[x, y] = (*col, round(255 * min(1, a)))
  return img.resize((size, size), Image.LANCZOS)

out = sys.argv[1]
big = render(512)
big.save(f"{out}/icon.png")
big.save(f"{out}/icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
render(32, ring=0.31, width=0.13, glow=False, core=0.13).save(f"{out}/tray.png")
render(128).save(f"{out}/preview128.png")
