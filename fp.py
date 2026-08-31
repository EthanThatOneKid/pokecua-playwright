"""Fingerprint a screenshot by sampling pixel values and quantizing to 16 levels.
Output: MD5 hash of sampled pixel data. Same visual content = same hash.
"""
import sys
from PIL import Image
import hashlib

def fingerprint(path):
    img = Image.open(path).convert('RGB')
    # Sample 100 fixed pixel positions (10x10 grid)
    pixels = []
    for y in range(10):
        for x in range(10):
            px = x * img.width // 10
            py = y * img.height // 10
            r, g, b = img.getpixel((px, py))
            # Quantize to 16 levels (reduces noise from animation frames)
            pixels.append((r // 16, g // 16, b // 16))
    return hashlib.md5(str(pixels).encode()).hexdigest()

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('', end='')
    else:
        print(fingerprint(sys.argv[1]), end='')
