#!/usr/bin/env python3
"""Generate talmud_index.json — the tractate/daf/amud picker data.

Queries Sefaria's shape API (https://www.sefaria.org/api/shape/{title}) for
the 37 Babylonian Talmud tractates that have Gemara, and derives each one's
daf range and amud (page-side) layout from the returned per-amud length
array. Every tractate starts at daf 2 (daf 1 does not exist in the standard
Vilna pagination); this is asserted, not assumed. A handful of tractates have
a genuinely missing amud partway through (e.g. Nazir 33b) — those are
recorded in "skipAmudim" so the GUI picker can leave them out rather than
offer a reading that Sefaria has no text for.

Run this only to regenerate talmud_index.json (e.g. if Sefaria's pagination
data changes); the GUI app loads the committed JSON output, it does not call
this script or Sefaria's shape API at runtime.
"""

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

TRACTATES = [
    "Berakhot",
    "Shabbat", "Eruvin", "Pesachim", "Yoma", "Sukkah", "Beitzah",
    "Rosh Hashanah", "Taanit", "Megillah", "Moed Katan", "Chagigah",
    "Yevamot", "Ketubot", "Nedarim", "Nazir", "Sotah", "Gittin", "Kiddushin",
    "Bava Kamma", "Bava Metzia", "Bava Batra", "Sanhedrin", "Makkot",
    "Shevuot", "Avodah Zarah", "Horayot",
    "Zevachim", "Menachot", "Chullin", "Bekhorot", "Arakhin", "Temurah",
    "Keritot", "Meilah",
    "Niddah",
]


def fetch_shape(title, attempts=4):
    url = f"https://www.sefaria.org/api/shape/{urllib.parse.quote(title)}"
    last = None
    for _ in range(attempts):
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                data = json.loads(r.read())
            return data[0] if isinstance(data, list) else data
        except (urllib.error.URLError, urllib.error.HTTPError) as e:
            last = e
            time.sleep(1.5)
    raise RuntimeError(f"Could not fetch shape for {title!r}: {last}")


def build_entry(title, shape):
    chapters = shape["chapters"]
    length = shape["length"]
    if chapters[0] != 0 or chapters[1] != 0:
        raise AssertionError(
            f"{title}: expected daf-1 placeholders to be empty, got "
            f"{chapters[:2]} — Sefaria's pagination assumption may have "
            f"changed, review before trusting this data.")
    last_idx = length - 1
    end_daf = last_idx // 2 + 1
    end_side = "a" if last_idx % 2 == 0 else "b"
    skip_amudim = []
    for i in range(2, length):
        if chapters[i] == 0:
            daf = i // 2 + 1
            side = "a" if i % 2 == 0 else "b"
            skip_amudim.append(f"{daf}{side}")
    return {
        "name": title,
        "hebrewName": shape.get("heTitle", ""),
        "seder": shape.get("section", ""),
        "startDaf": 2,
        "endDaf": end_daf,
        "endSide": end_side,
        "skipAmudim": skip_amudim,
    }


def main():
    tractates = []
    for title in TRACTATES:
        shape = fetch_shape(title)
        entry = build_entry(title, shape)
        tractates.append(entry)
        print(f"{title:15s} 2a - {entry['endDaf']}{entry['endSide']}"
              f"{'  skip=' + str(entry['skipAmudim']) if entry['skipAmudim'] else ''}")

    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                             "talmud_index.json")
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump({"tractates": tractates}, fh, ensure_ascii=False, indent=2)
    print(f"\nWrote {out_path} ({len(tractates)} tractates)")


if __name__ == "__main__":
    main()
