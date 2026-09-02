"""
extract_transcript.py
----------------------
Pulls the timestamped transcript for a YouTube video and saves it as JSON.

Uses the TranscriptAPI.com REST API (https://transcriptapi.com) instead of
scraping YouTube directly, since YouTube blocks direct/unofficial access
from most cloud IPs (including GitHub Actions runners).

Install:
    pip install requests --break-system-packages

Env:
    export TRANSCRIPT_API_KEY=your_key_here
    (get one from https://transcriptapi.com/dashboard -> API Keys)

Usage:
    python extract_transcript.py <video_id_or_url> [--lang hi en]

Output:
    transcript_<video_id>.json  ->  [{"start": 1.2, "duration": 3.4, "text": "..."}]
"""

import argparse
import json
import os
import re
import sys
import time

import requests

API_BASE = "https://transcriptapi.com/api/v2"
RETRYABLE_CODES = {408, 429, 503}
MAX_RETRIES = 3


def get_video_id(url_or_id: str) -> str:
    """Accepts a raw video ID or any common YouTube URL format."""
    patterns = [
        r"(?:v=|\/)([0-9A-Za-z_-]{11}).*",
        r"youtu\.be\/([0-9A-Za-z_-]{11})",
    ]
    for p in patterns:
        m = re.search(p, url_or_id)
        if m:
            return m.group(1)
    # assume it's already a bare ID
    if re.fullmatch(r"[0-9A-Za-z_-]{11}", url_or_id):
        return url_or_id
    raise ValueError(f"Could not parse video ID from: {url_or_id}")


def _api_key() -> str:
    key = os.environ.get("TRANSCRIPT_API_KEY")
    if not key:
        raise RuntimeError(
            "TRANSCRIPT_API_KEY is not set. Get a key from "
            "https://transcriptapi.com/dashboard and export it as an "
            "environment variable (or add it as a repo secret in CI)."
        )
    return key


def fetch_transcript(video_id: str, languages=("hi", "en")):
    """
    Fetches a transcript via TranscriptAPI.com.

    Tries each language in `languages` in order (first one with a transcript
    wins). Returns a list of {"start": float, "duration": float, "text": str}
    dicts, matching the shape the rest of the pipeline expects.
    """
    headers = {"Authorization": f"Bearer {_api_key()}"}
    last_error = None

    for lang in languages:
        params = {
            "video_url": video_id,
            "format": "json",
            "include_timestamp": "true",
            "send_metadata": "false",
            "language": lang,
        }

        for attempt in range(MAX_RETRIES):
            try:
                resp = requests.get(
                    f"{API_BASE}/youtube/transcript",
                    headers=headers,
                    params=params,
                    timeout=30,
                )
            except requests.exceptions.RequestException as e:
                last_error = e
                if attempt < MAX_RETRIES - 1:
                    time.sleep(2 ** attempt)
                    continue
                break

            if resp.status_code == 200:
                data = resp.json()
                return [
                    {
                        "start": round(seg["start"], 2),
                        "duration": round(seg["duration"], 2),
                        "text": seg["text"],
                    }
                    for seg in data.get("transcript", [])
                ]

            if resp.status_code == 404:
                # No transcript in this language for this video; try the next one.
                last_error = RuntimeError(f"No '{lang}' transcript for {video_id}")
                break

            if resp.status_code == 402:
                detail = resp.json().get("detail", {})
                raise RuntimeError(
                    f"TranscriptAPI billing issue: {detail.get('message', resp.text)} "
                    f"({detail.get('action_url', '')})"
                )

            if resp.status_code == 401:
                raise RuntimeError("TranscriptAPI rejected the API key (401). Check TRANSCRIPT_API_KEY.")

            if resp.status_code in RETRYABLE_CODES:
                retry_after = float(resp.headers.get("Retry-After", 2 ** attempt))
                last_error = RuntimeError(f"HTTP {resp.status_code} from TranscriptAPI")
                if attempt < MAX_RETRIES - 1:
                    time.sleep(retry_after)
                    continue
                break

            # Non-retryable error (400/422/etc) - stop trying this language.
            last_error = RuntimeError(f"TranscriptAPI error {resp.status_code}: {resp.text}")
            break

    raise RuntimeError(
        f"Could not fetch transcript for {video_id} in any of {languages}: {last_error}"
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("video", help="YouTube video URL or ID")
    parser.add_argument("--lang", nargs="+", default=["hi", "en"],
                         help="Preferred language codes, in priority order")
    parser.add_argument("--out", default=None, help="Output JSON path")
    args = parser.parse_args()

    video_id = get_video_id(args.video)
    print(f"Fetching transcript for video: {video_id}")

    segments = fetch_transcript(video_id, tuple(args.lang))

    out_path = args.out or f"transcript_{video_id}.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"video_id": video_id, "segments": segments}, f, ensure_ascii=False, indent=2)

    print(f"Saved {len(segments)} segments -> {out_path}")


if __name__ == "__main__":
    main()
