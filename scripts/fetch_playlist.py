"""
fetch_playlist.py
------------------
Lists every video ID + title in a YouTube playlist, in order.

Uses the TranscriptAPI.com REST API (https://transcriptapi.com) instead of
yt-dlp, since YouTube blocks direct/unofficial access from most cloud IPs
(including GitHub Actions runners).

Install:
    pip install requests --break-system-packages

Env:
    export TRANSCRIPT_API_KEY=your_key_here
    (get one from https://transcriptapi.com/dashboard -> API Keys)

Usage:
    python fetch_playlist.py <playlist_url_or_id> --out playlist.json
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


def get_playlist_id(url_or_id: str) -> str:
    """Accepts a raw playlist ID or a playlist/watch URL containing ?list=."""
    m = re.search(r"[?&]list=([A-Za-z0-9_-]+)", url_or_id)
    if m:
        return m.group(1)
    if re.fullmatch(r"(PL|UU|LL|FL|OL)[A-Za-z0-9_-]+", url_or_id):
        return url_or_id
    raise ValueError(f"Could not parse playlist ID from: {url_or_id}")


def _api_key() -> str:
    key = os.environ.get("TRANSCRIPT_API_KEY")
    if not key:
        raise RuntimeError(
            "TRANSCRIPT_API_KEY is not set. Get a key from "
            "https://transcriptapi.com/dashboard and export it as an "
            "environment variable (or add it as a repo secret in CI)."
        )
    return key


def _get_page(headers, params):
    for attempt in range(MAX_RETRIES):
        try:
            resp = requests.get(
                f"{API_BASE}/youtube/playlist/videos",
                headers=headers,
                params=params,
                timeout=30,
            )
        except requests.exceptions.RequestException as e:
            if attempt < MAX_RETRIES - 1:
                time.sleep(2 ** attempt)
                continue
            raise RuntimeError(f"Network error fetching playlist page: {e}")

        if resp.status_code == 200:
            return resp.json()

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
            if attempt < MAX_RETRIES - 1:
                time.sleep(retry_after)
                continue
            raise RuntimeError(f"HTTP {resp.status_code} from TranscriptAPI after retries")

        raise RuntimeError(f"TranscriptAPI error {resp.status_code}: {resp.text}")

    raise RuntimeError("Exhausted retries fetching playlist page")


def fetch_playlist_entries(playlist_url_or_id: str):
    """Fetches every video in a playlist, paginating via continuation_token."""
    playlist_id = get_playlist_id(playlist_url_or_id)
    headers = {"Authorization": f"Bearer {_api_key()}"}

    entries = []
    params = {"playlist_id": playlist_id}

    while True:
        data = _get_page(headers, params)
        for r in data.get("results", []):
            entries.append({
                "video_id": r.get("videoId"),
                "title": r.get("title"),
            })

        if not data.get("has_more") or not data.get("continuation_token"):
            break
        params = {"continuation": data["continuation_token"]}

    return entries


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("playlist", help="Playlist URL or ID")
    parser.add_argument("--out", default="playlist.json")
    args = parser.parse_args()

    entries = fetch_playlist_entries(args.playlist)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump({"videos": entries}, f, ensure_ascii=False, indent=2)

    print(f"Found {len(entries)} videos -> {args.out}")


if __name__ == "__main__":
    main()
