"""
analyze_questions.py
---------------------
Reads transcript_<id>.json (from extract_transcript.py) and asks a Gemini
model to split it into quiz questions, each with a start timestamp (seconds)
and a short title/summary.

Why chunking + gap-filling instead of one giant call:
A single request over a long (45-90 min) transcript technically fits in the
model's context window, but in practice the model tends to under-report -
it skims, merges adjacent questions together, or quietly drops ones in the
middle of a long transcript. That's the #1 cause of "found 19 questions,
should have been 25".

To fix this we:
  1. Split the transcript into overlapping time-based chunks and analyze
     each chunk separately, so no single call has to track 25 questions
     across an hour of text.
  2. Merge + dedupe results from overlapping chunks (a question near a
     chunk boundary may get reported by both neighboring chunks).
  3. Look for suspiciously large gaps between consecutive found questions
     and re-query the model on just that slice of transcript, specifically
     asking "did we miss something here?". Repeat a few times.
  4. If an --expected-questions count is known, keep gap-filling until we
     hit it (or give up after a bounded number of extra passes) and warn
     loudly if we still fall short.

Install:
    pip install google-genai --break-system-packages

Set your API key (from https://aistudio.google.com/apikey):
    export GEMINI_API_KEY=...

Usage:
    python analyze_questions.py transcript_XXXXXXXXXXX.json
    python analyze_questions.py transcript_XXXXXXXXXXX.json --expected-questions 25
"""

import argparse
import json
import os
import sys
import time
from google import genai
from google.genai import types
from google.genai.errors import APIError

# Gemini 3.5 Flash-Lite: Google's newest budget tier ($0.30 / $2.50 per 1M
# input/output tokens), successor to 2.5 Flash-Lite, with a large context
# window - big enough to send a full transcript in a single request, no
# chunking needed *token-wise* (chunking here is for accuracy, not size).
MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite")

MAX_OUTPUT_TOKENS = int(os.environ.get("GEMINI_MAX_OUTPUT_TOKENS", "4000"))

# Chunking knobs. Chunks are windows over the transcript's own time axis
# (seg["start"]), not segment counts, so they adapt to fast/slow talkers.
CHUNK_SECONDS = float(os.environ.get("QUIZ_CHUNK_SECONDS", "600"))     # 10 min per chunk
CHUNK_OVERLAP_SECONDS = float(os.environ.get("QUIZ_CHUNK_OVERLAP", "90"))  # 1.5 min overlap
# Below this total duration, just do one pass - chunking a 5 min video adds
# no accuracy and only costs extra calls.
CHUNK_MIN_TOTAL_SECONDS = float(os.environ.get("QUIZ_CHUNK_MIN_TOTAL", "900"))

# Gap-filling knobs.
MAX_GAP_FILL_PASSES = int(os.environ.get("QUIZ_MAX_GAP_PASSES", "3"))
# A gap between two consecutive found questions is "suspicious" if it's both
# noticeably bigger than the typical gap AND long enough in absolute terms
# that a whole question could be hiding inside it.
GAP_RATIO_THRESHOLD = 2.2
GAP_ABS_MIN_SECONDS = 180.0
# Two reported questions within this many seconds of each other are treated
# as the same question (dedupe), keeping the earlier timestamp.
DEDUPE_WINDOW_SECONDS = float(os.environ.get("QUIZ_DEDUPE_WINDOW", "20"))

SYSTEM_PROMPT = """You are analyzing the transcript of an exam-prep / quiz-review video.
The teacher goes through quiz questions one by one, discussing the solution to each.

Your job: identify each NEW question the teacher starts discussing, in order,
and return the timestamp (in seconds) where the discussion of that question begins.

Rules:
- Only mark the moment a NEW question starts (not sub-steps within the same question).
- Ignore intros, banter, or wrap-up commentary - only number actual quiz questions.
- Be thorough: err on the side of reporting a borderline case as a new question
  rather than silently merging it into the previous one. Missing a question is
  worse than over-reporting one.
- Give each question a short (<12 word) topic label, in English, summarizing what it's about.
- Output ONLY valid JSON, no markdown fences, no commentary. Format:

{
  "questions": [
    {"number": 1, "start_seconds": 351, "label": "Income split between essentials and rent"},
    {"number": 2, "start_seconds": 448, "label": "Mixing two varieties of sugar, no profit/loss"}
  ]
}
"""

# Used for both chunk passes (with a NOTE about the chunk being a slice) and
# gap-fill passes (with a NOTE that we're specifically hunting a missed one).
CHUNK_NOTE = """
NOTE: The transcript below is only a SLICE of a longer video (roughly
{start_min:.1f} to {end_min:.1f} minutes in). It may start or end mid-question.
Only report questions whose start you can actually see beginning in this slice.
"""

GAP_FILL_NOTE = """
NOTE: This is a short slice between two quiz questions that were already
found, at roughly {start_min:.1f} and {end_min:.1f} minutes into the video.
We suspect a question may have been missed in between. Carefully check
whether a new question actually starts somewhere in this slice. If nothing
new starts here, return an empty "questions" list - do not force a match.
"""


def seconds_from_segments(segments):
    """Builds a single text blob with inline [t=SECONDS] markers so the model
    can cite exact timestamps."""
    lines = []
    for seg in segments:
        lines.append(f"[t={seg['start']}] {seg['text']}")
    return "\n".join(lines)


def _call_model(client, blob, extra_instruction="", retries=3):
    """Calls the Gemini model on a transcript (or transcript slice), retrying
    with backoff on transient errors (e.g. 429 rate limit, 503 overloaded)."""
    if not blob.strip():
        return {"questions": []}

    system_instruction = SYSTEM_PROMPT + (("\n" + extra_instruction) if extra_instruction else "")
    delay = 15
    for attempt in range(1, retries + 1):
        try:
            resp = client.models.generate_content(
                model=MODEL,
                contents=blob,
                config=types.GenerateContentConfig(
                    system_instruction=system_instruction,
                    response_mime_type="application/json",
                    max_output_tokens=MAX_OUTPUT_TOKENS,
                ),
            )
            text = (resp.text or "").strip().strip("`")
            if text.startswith("json"):
                text = text[4:].strip()
            parsed = json.loads(text)
            if not isinstance(parsed.get("questions"), list):
                raise ValueError("response missing a 'questions' list")
            return parsed
        except (APIError, json.JSONDecodeError, ValueError) as e:
            if attempt == retries:
                print(f"    request failed after {retries} attempts: {e}")
                return {"questions": []}
            print(f"    error ({e}); retrying in {delay}s...")
            time.sleep(delay)
            delay *= 2
    return {"questions": []}


def _make_chunks(segments):
    """Splits segments into overlapping time-based windows. Returns a list of
    (chunk_start, chunk_end, segments_in_window)."""
    if not segments:
        return []

    total_end = max(seg["start"] for seg in segments)
    if total_end <= CHUNK_MIN_TOTAL_SECONDS:
        return [(0.0, total_end, segments)]

    chunks = []
    window_start = 0.0
    step = max(CHUNK_SECONDS - CHUNK_OVERLAP_SECONDS, 60.0)  # guard against bad config
    while window_start <= total_end:
        window_end = window_start + CHUNK_SECONDS
        chunk_segs = [s for s in segments if window_start <= s["start"] < window_end]
        if chunk_segs:
            chunks.append((window_start, min(window_end, total_end), chunk_segs))
        if window_end >= total_end:
            break
        window_start += step
    return chunks


def _dedupe_and_renumber(questions):
    """Sorts by start_seconds and collapses entries that land within
    DEDUPE_WINDOW_SECONDS of an already-kept question (keeps the earlier one,
    since that's more likely to be the true start of the discussion)."""
    questions = sorted(
        (q for q in questions if isinstance(q.get("start_seconds"), (int, float))),
        key=lambda q: q["start_seconds"],
    )
    deduped = []
    for q in questions:
        if deduped and (q["start_seconds"] - deduped[-1]["start_seconds"]) < DEDUPE_WINDOW_SECONDS:
            continue
        deduped.append(q)
    for idx, q in enumerate(deduped, 1):
        q["number"] = idx
    return deduped


def _find_gaps(questions, total_end):
    """Returns a list of (gap_start, gap_end) slices worth re-checking:
    consecutive question starts whose spacing is a clear outlier relative to
    the video's typical question spacing."""
    if len(questions) < 2:
        return []

    starts = [q["start_seconds"] for q in questions]
    diffs = [b - a for a, b in zip(starts, starts[1:])]
    diffs_sorted = sorted(diffs)
    mid = len(diffs_sorted) // 2
    median_gap = (
        diffs_sorted[mid]
        if len(diffs_sorted) % 2
        else (diffs_sorted[mid - 1] + diffs_sorted[mid]) / 2
    ) or 1.0

    gaps = []
    for a, b in zip(starts, starts[1:]):
        gap = b - a
        if gap >= GAP_ABS_MIN_SECONDS and gap >= GAP_RATIO_THRESHOLD * median_gap:
            gaps.append((a, b))
    return gaps


def _slice_segments(segments, start, end):
    return [s for s in segments if start <= s["start"] < end]


def analyze_transcript(segments, client, expected_questions=None):
    """Analyzes a full transcript's segments and returns {"questions": [...]}.

    Runs in three phases:
      1. Chunked first pass over the whole transcript.
      2. Gap-filling passes over suspiciously large gaps between found
         questions (repeated up to MAX_GAP_FILL_PASSES times, or until
         expected_questions is reached if that's known).
      3. Final sort/dedupe/renumber.
    """
    if not segments:
        return {"questions": []}

    total_end = max(seg["start"] for seg in segments)
    chunks = _make_chunks(segments)

    all_questions = []
    for i, (c_start, c_end, chunk_segs) in enumerate(chunks, 1):
        print(f"    pass 1: chunk {i}/{len(chunks)} ({c_start/60:.1f}-{c_end/60:.1f} min)...")
        blob = seconds_from_segments(chunk_segs)
        note = (
            CHUNK_NOTE.format(start_min=c_start / 60, end_min=c_end / 60)
            if len(chunks) > 1
            else ""
        )
        result = _call_model(client, blob, extra_instruction=note)
        all_questions.extend(result.get("questions", []))

    questions = _dedupe_and_renumber(all_questions)
    print(f"    pass 1 done: {len(questions)} question(s) found")

    for pass_num in range(1, MAX_GAP_FILL_PASSES + 1):
        if expected_questions and len(questions) >= expected_questions:
            break

        gaps = _find_gaps(questions, total_end)
        # Also treat "before the first found question" as a gap worth
        # checking once, in case the pipeline missed the very first question.
        if questions:
            first_start = questions[0]["start_seconds"]
            if first_start >= GAP_ABS_MIN_SECONDS:
                gaps.insert(0, (0.0, first_start))
        if not gaps:
            break

        print(f"    gap-fill pass {pass_num}: checking {len(gaps)} gap(s)...")
        new_questions = []
        for gap_start, gap_end in gaps:
            # Pad a little so we don't clip the actual start of a question
            # that begins right at the gap boundary.
            slice_segs = _slice_segments(
                segments, max(0.0, gap_start - 15), gap_end + 15
            )
            blob = seconds_from_segments(slice_segs)
            note = GAP_FILL_NOTE.format(
                start_min=gap_start / 60, end_min=gap_end / 60
            )
            result = _call_model(client, blob, extra_instruction=note)
            found = result.get("questions", [])
            if found:
                print(
                    f"      found {len(found)} question(s) in "
                    f"{gap_start/60:.1f}-{gap_end/60:.1f} min gap"
                )
            new_questions.extend(found)

        if not new_questions:
            # Nothing new turned up this pass; further passes over the same
            # gaps won't help, so stop early.
            break

        questions = _dedupe_and_renumber(questions + new_questions)

    if expected_questions and len(questions) != expected_questions:
        print(
            f"    WARNING: expected {expected_questions} questions, "
            f"ended up with {len(questions)}. You may want to check the "
            f"transcript/video manually around the largest remaining gaps."
        )

    return {"questions": questions}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("transcript_json", help="Path to transcript_<id>.json")
    parser.add_argument("--out", default=None, help="Output JSON path")
    parser.add_argument(
        "--expected-questions",
        type=int,
        default=None,
        help="If you know how many questions the video covers (e.g. 25), "
        "gap-filling will keep going until it finds that many (or exhausts "
        "its retry budget), and a warning is printed if it still falls short.",
    )
    args = parser.parse_args()

    with open(args.transcript_json, encoding="utf-8") as f:
        data = json.load(f)

    video_id = data["video_id"]

    client = genai.Client()  # reads GEMINI_API_KEY from env

    result = analyze_transcript(
        data["segments"], client, expected_questions=args.expected_questions
    )
    result["video_id"] = video_id

    out_path = args.out or f"questions_{video_id}.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(f"Found {len(result['questions'])} questions -> {out_path}")


if __name__ == "__main__":
    main()
