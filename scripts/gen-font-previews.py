#!/usr/bin/env python3
"""
글꼴 목록 미리보기용 "이름 글자만" 부분집합 + 번들 3종 내려받기 (docs/PLAN-2026-10-27-fonts.md 후속, 2026-10-28).

하는 일
  1. src/lib/fonts/catalog.json 의 글꼴마다 weight 400 면(face)을 jsDelivr(fontsource)에서 받아(sha256 검증) 표시 이름에 쓰이는
     글자만 남긴 woff2 를 src/assets/fonts/previews/<id>-<korean|latin>.woff2 로 쓴다. 설정 글꼴 목록이 받지 않은 글꼴도
     자기 글꼴로 미리 보이게 하는 파일이고, 한 개에 수 KB 다. 목록: src/lib/fonts/previews.json.
  2. BUNDLED 글꼴(통째로 설치본에 넣는 작은 한국어 글꼴 3종)의 모든 면을 src/assets/fonts/bundled/<id>/ 로 받는다.

OFL 1.1: 글꼴 이름을 예약(RFN)한 글꼴은 부분집합도 "수정본"이라 이름을 바꿔야 한다 — 카탈로그에는 RFN 글꼴이 없다(SUIT·Spoqa 제외, 문서 §2).
          부분집합에도 원본 저작권·라이선스 고지는 NOTICES 에 남는다(카탈로그의 copyright/license 필드).

사용: pip install fonttools brotli  →  python scripts/gen-font-previews.py
      결과 파일은 커밋한다(재생성은 카탈로그가 바뀔 때만).
"""
import hashlib
import io
import json
import os
import sys
import urllib.request

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CATALOG = os.path.join(ROOT, "src", "lib", "fonts", "catalog.json")
PREVIEW_DIR = os.path.join(ROOT, "src", "assets", "fonts", "previews")
BUNDLED_DIR = os.path.join(ROOT, "src", "assets", "fonts", "bundled")
PREVIEW_INDEX = os.path.join(ROOT, "src", "lib", "fonts", "previews.json")
# 통째로 번들하는 작은 한국어 글꼴 — src/lib/fonts/bundled.ts 의 BUNDLED_IDS 와 같아야 한다.
BUNDLED = ["hahmlet", "do-hyeon", "black-han-sans"]


def fetch(face):
    data = urllib.request.urlopen(face["url"], timeout=60).read()
    if hashlib.sha256(data).hexdigest() != face["sha256"]:
        sys.exit(f"sha256 mismatch: {face['file']}")
    return data


def main():
    fonts = json.load(open(CATALOG, encoding="utf-8"))["fonts"]
    os.makedirs(PREVIEW_DIR, exist_ok=True)
    index = {}
    for f in fonts:
        text = f["name"]
        entries = []
        for face in [x for x in f["faces"] if x["weight"] == 400]:
            raw = fetch(face)
            font = TTFont(io.BytesIO(raw))
            opts = subset.Options()
            opts.flavor = "woff2"
            opts.layout_features = []
            opts.hinting = False
            opts.notdef_outline = False
            opts.name_IDs = [0, 1, 2, 3, 4, 6, 13, 14]  # 저작권(0)·라이선스(13, 14) 보존
            sub = subset.Subsetter(opts)
            sub.populate(text=text)
            sub.subset(font)
            cmap = font.getBestCmap() or {}
            if not any(chr(c) in text for c in cmap):
                continue  # 이 면에는 이름 글자가 하나도 없다(예: 한글 이름의 라틴 면)
            kind = "latin" if "latin" in face["file"] else "korean" if "korean" in face["file"] else "face"
            out = f"{f['id']}-{kind}.woff2"
            buf = io.BytesIO()
            font.flavor = "woff2"
            font.save(buf)
            open(os.path.join(PREVIEW_DIR, out), "wb").write(buf.getvalue())
            e = {"file": out}
            if face.get("unicode_range"):
                e["unicode_range"] = face["unicode_range"]
            entries.append(e)
        if entries:
            index[f["id"]] = entries
        print(f["id"], [e["file"] for e in entries])
    json.dump(index, open(PREVIEW_INDEX, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    for fid in BUNDLED:
        f = next(x for x in fonts if x["id"] == fid)
        d = os.path.join(BUNDLED_DIR, fid)
        os.makedirs(d, exist_ok=True)
        for face in f["faces"]:
            open(os.path.join(d, face["file"]), "wb").write(fetch(face))
        print("bundled", fid)


if __name__ == "__main__":
    main()
