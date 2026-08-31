import sys
from PIL import Image
import hashlib

path = sys.argv[1]
img = Image.open(path).convert('RGB')
w, h = img.size
pixels = []
for i in range(10):
    for j in range(10):
        x = int(w * (i + 0.5) / 10)
        y = int(h * (j + 0.5) / 10)
        r, g, b = img.getpixel((x, y))
        pixels.extend([r // 16 * 16, g // 16 * 16, b // 16 * 16])
print(hashlib.md5(bytes(pixels)).hexdigest())
