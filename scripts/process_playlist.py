"""
process_playlist.py
--------------------
Runs the full pipeline over an entire playlist, but skips videos that have
already been processed (so re-running after a new upload only costs API
calls for the new video, not all 60).

Install:
    pip install requests google-genai --break-system-packages

Env:
    export GEMINI_API_KEY=... (from https://aistudio.google.com/apikey)
    export TRANSCRIPT_API_KEY=... (from https://transcriptapi.com/dashboard)

Usage:
    python process_playlist.py <playlist_url_or_id> --out-dir ../web/data
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

from extract_transcript import fetch_transcript
from fetch_playlist import fetch_playlist_entries
from analyze_questions import analyze_transcript
from google import genai


def load_index(out_dir: Path):
    index_path = out_dir / "index.json"
    if index_path.exists():
        with open(index_path, encoding="utf-8") as f:
            return json.load(f)
    return {"videos": []}


def save_index(out_dir: Path, index):
    with open(out_dir / "index.json", "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)


def process_one_video(video_id: str, title: str, client: genai.Client, out_dir: Path):
    print(f"  Fetching transcript for {video_id} ({title})...")
    try:
        segments = fetch_transcript(video_id, ("hi", "en"))
    except Exception as e:
        print(f"  SKIP - no transcript available: {e}")
        return None

    print(f"  Analyzing with Gemini...")
    result = analyze_transcript(segments, client)
    result["video_id"] = video_id
    result["title"] = title

    out_path = out_dir / f"questions_{video_id}.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(f"  Saved {len(result.get('questions', []))} questions -> {out_path.name}")
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("playlist", help="Playlist URL or ID")
    parser.add_argument("--out-dir", default="../web/data")
    parser.add_argument("--sleep", type=float, default=2.0,
                         help="Seconds to wait between videos (be gentle on rate limits)")
    args = parser.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    index = load_index(out_dir)
    processed_ids = {v["video_id"] for v in index["videos"]}

    print("Fetching playlist entries...")
    entries = fetch_playlist_entries(args.playlist)
    print(f"Playlist has {len(entries)} videos. {len(processed_ids)} already processed.")

    new_entries = [e for e in entries if e["video_id"] not in processed_ids]
    if not new_entries:
        print("Nothing new to process.")
        return

    client = genai.Client()  # reads GEMINI_API_KEY from env
    added = 0

    for i, entry in enumerate(new_entries, 1):
        print(f"[{i}/{len(new_entries)}] {entry['video_id']}")
        result = process_one_video(entry["video_id"], entry["title"], client, out_dir)
        if result:
            index["videos"].append({
                "video_id": entry["video_id"],
                "title": entry["title"],
                "question_count": len(result.get("questions", [])),
            })
            added += 1
        time.sleep(args.sleep)

    # Keep index in playlist order
    order = {e["video_id"]: i for i, e in enumerate(entries)}
    index["videos"].sort(key=lambda v: order.get(v["video_id"], 999999))

    save_index(out_dir, index)
    print(f"Done. Added {added} new videos. Index now has {len(index['videos'])} total.")


if __name__ == "__main__":
    main()
