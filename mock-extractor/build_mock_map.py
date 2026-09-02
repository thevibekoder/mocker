"""
build_mock_map.py
------------------
Bridges the two data pools:

  1. The YouTube pipeline's output (index.json + questions_<video_id>.json,
     produced by extract_transcript.py / analyze_questions.py / process_playlist.py)
     - keyed by video_id, has per-question start_seconds.

  2. The Mock Extractor Chrome extension, which tags each saved question with
     a "mockLabel" like "MOCK-09" scraped directly off the test page.

This script reads (1) and writes a single mock-timestamp-map.json keyed by
that same "MOCK-09" label, so the extension can look up a timestamp the
moment you click "Save this question" on the live mock page.

Usage:
    python build_mock_map.py --data-dir ../web/data --out mock-timestamp-map.json

How the mock number is found:
    Looks for MOCK / Mock Test / Mock-No patterns in each video's title,
    e.g. "Mock Test - 9 | Full Discussion" -> "MOCK-09"
         "MOCK 12 Solutions"                -> "MOCK-12"
    Videos whose title doesn't match anything are skipped (printed as a
    warning) so you can rename them or fix the pattern below.
"""

import argparse
import json
import re
from pathlib import Path

MOCK_PATTERN = re.compile(r"mock[\s\-_]*(?:test)?[\s\-_#]*0*(\d+)", re.IGNORECASE)


def mock_label_from_title(title: str) -> str | None:
    m = MOCK_PATTERN.search(title or "")
    if not m:
        return None
    return "MOCK-" + m.group(1).zfill(2)


def build_map(data_dir: Path):
    index_path = data_dir / "index.json"
    with open(index_path, encoding="utf-8") as f:
        index = json.load(f)

    out = {}
    skipped = []

    for video in index["videos"]:
        video_id = video["video_id"]
        title = video.get("title", "")
        label = mock_label_from_title(title)
        if not label:
            skipped.append((video_id, title))
            continue

        qpath = data_dir / f"questions_{video_id}.json"
        if not qpath.exists():
            skipped.append((video_id, title + "  [no questions file]"))
            continue

        with open(qpath, encoding="utf-8") as f:
            qdata = json.load(f)

        questions = qdata.get("questions", [])
        q_map = {}
        for i, q in enumerate(questions):
            start = q["start_seconds"]
            end = questions[i + 1]["start_seconds"] if i + 1 < len(questions) else None
            q_map[str(q["number"])] = {"start": start, "end": end}

        if label in out:
            print(f"WARNING: duplicate label {label} - "
                  f"'{out[label]['videoTitle']}' vs '{title}'. Keeping the first one.")
            continue

        out[label] = {
            "videoId": video_id,
            "videoTitle": title,
            "questions": q_map,
        }

    return out, skipped


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", default="../web/data",
                         help="Folder containing index.json + questions_<id>.json")
    parser.add_argument("--out", default="mock-timestamp-map.json")
    args = parser.parse_args()

    data_dir = Path(args.data_dir)
    out, skipped = build_map(data_dir)

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    print(f"Wrote {len(out)} mock(s) -> {args.out}")
    if skipped:
        print(f"\nSkipped {len(skipped)} video(s) - couldn't detect a mock number in the title:")
        for vid, title in skipped:
            print(f"  {vid}: {title}")
        print("\nRename these videos on YouTube (e.g. include 'Mock Test - N') "
              "or extend MOCK_PATTERN in this script, then re-run.")


if __name__ == "__main__":
    main()
