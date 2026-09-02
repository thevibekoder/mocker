# YouTube Quiz Timestamper

Three pieces that work together:

1. **`scripts/fetch_playlist.py`** — lists every video ID + title in a
   playlist using the [TranscriptAPI.com](https://transcriptapi.com) REST API.
2. **`scripts/extract_transcript.py`** — pulls the timestamped transcript for
   any YouTube video, also via TranscriptAPI.com.
3. **`scripts/analyze_questions.py`** — sends that transcript to Gemini and
   asks it to detect where each quiz question begins, returning a clean
   `questions_<id>.json` file: question number, start time in seconds, and a
   short label.
4. **`web/index.html`** — a quiz site. Click a question, click "Show
   solution," and the embedded YouTube player jumps straight to that
   question's timestamp (and stops automatically at the start of the next
   one).

TranscriptAPI.com is used instead of scraping YouTube directly (via
`youtube-transcript-api` or `yt-dlp`) because YouTube blocks direct/
unofficial access from most cloud IPs, including GitHub Actions runners.

## Setup

```bash
pip install requests google-genai --break-system-packages
export GEMINI_API_KEY=...
export TRANSCRIPT_API_KEY=...   # from https://transcriptapi.com/dashboard
```

## Run the pipeline

```bash
cd scripts
python extract_transcript.py https://youtu.be/VIDEO_ID --lang hi en
python analyze_questions.py transcript_VIDEO_ID.json
```

This produces `questions_VIDEO_ID.json`, e.g.:

```json
{
  "video_id": "VIDEO_ID",
  "questions": [
    {"number": 1, "start_seconds": 351, "label": "Income split between essentials and rent"},
    {"number": 2, "start_seconds": 448, "label": "Mixing two sugar varieties, no profit or loss"}
  ]
}
```

Move that file into `web/data/` and it's ready for the site.

## Wire it into the website

`web/index.html` currently has a sample dataset (25 questions from the demo
video) inlined directly in the `<script>` tag so you can open the file and
test it immediately — no server needed.

To load real generated data instead, replace the inline `QUESTION_DATA`
object with:

```js
const VIDEO_ID = "VIDEO_ID";
let QUESTION_DATA;
fetch(`data/questions_${VIDEO_ID}.json`)
  .then(r => r.json())
  .then(data => { QUESTION_DATA = data; renderList(); updateProgress(); });
```

(Fetching local JSON requires serving the folder, e.g. `python -m http.server`,
rather than opening the HTML file directly — browsers block `fetch()` on
`file://` URLs.)

## How the "jump to timestamp" part works

The site uses YouTube's standard embed parameters — no video download or
re-hosting needed:

```
https://www.youtube.com/embed/VIDEO_ID?start=SECONDS&end=SECONDS&autoplay=1
```

- `start` cues the player to that question's timestamp.
- `end` is set to the *next* question's timestamp, so playback naturally
  stops before it spills into the next solution.
- A fresh `<iframe>` is created per click, so switching questions always
  reloads cleanly at the new timestamp.

## Whole playlist, kept up to date automatically

For a playlist (e.g. ~60 videos) that grows over time, use the automated
version instead of running the two scripts by hand per video.

### 1. Local test run (optional but recommended first)

```bash
pip install requests google-genai --break-system-packages
export GEMINI_API_KEY=...
export TRANSCRIPT_API_KEY=...   # from https://transcriptapi.com/dashboard
cd scripts
python process_playlist.py "https://www.youtube.com/playlist?list=YOUR_PLAYLIST_ID" --out-dir ../web/data
```

This writes one `questions_<video_id>.json` per video plus a master
`web/data/index.json` listing every processed video (id, title, question
count). Re-running it later only processes videos not already in
`index.json` — cheap and safe to run repeatedly.

### 2. Push the repo to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

### 3. Add secrets/variables (Settings → Secrets and variables → Actions)

- **Secret** `GEMINI_API_KEY` — your Gemini API key (from https://aistudio.google.com/apikey)
- **Secret** `TRANSCRIPT_API_KEY` — your TranscriptAPI.com API key
- **Variable** `PLAYLIST_URL` — the playlist URL

### 4. Enable the scheduled workflow

`.github/workflows/update-playlist.yml` is already included. It:
- Runs daily (cron `0 3 * * *` — edit to taste) and can also be triggered
  manually from the **Actions** tab
- Fetches the current playlist, finds any videos not yet in `index.json`
- Extracts + analyzes only those new videos
- Commits the new JSON files straight back to the repo

### 5. Turn on GitHub Pages

Settings → Pages → deploy from branch `main`, folder `/web`. Your site is
now live at `https://YOUR_USERNAME.github.io/YOUR_REPO/`, and every time the
workflow finds a new video in the playlist, the site updates itself within
one commit — no redeploy step needed since Pages rebuilds automatically.

### How the website now handles multiple videos

`web/index.html` loads `data/index.json` on page load to build the playlist
sidebar, then fetches the matching `data/questions_<video_id>.json` when you
click a video. Because it uses `fetch()`, you can't just double-click the
HTML file locally anymore — either serve it (`python -m http.server` from
`web/`) or rely on GitHub Pages once deployed.

### 6. Point the extension at the hosted map (one-time, ~30 seconds)

Once GitHub Pages is live, your map file sits at a public URL:

```
https://YOUR_USERNAME.github.io/YOUR_REPO/data/mock-timestamp-map.json
```

In the extension popup, paste that URL into **"Timestamp source"** and click
**Save URL**. That's the only manual step, ever. From here on:

- The extension checks that URL in the background every hour (via a Chrome
  alarm) and refreshes its local cache automatically.
- It also refreshes on-demand if the cache is more than 3 hours stale at the
  moment you save a question.
- When you click **Save this question**, it reads the `MOCK-XX` label off
  the page, looks it up in the cached map, and — if a match exists —
  silently attaches the video ID + timestamp to that saved question. No
  extra click, no re-import, nothing to remember.

If a mock was added to the playlist less than an hour ago and hasn't been
picked up yet, click **Sync now** in the popup to force an immediate
refresh instead of waiting for the hourly alarm.

### How the pieces stay in sync automatically

```
New mock uploaded to YouTube playlist
        │
        ▼ (daily cron, or trigger manually from Actions tab)
process_playlist.py   → transcript + AI-detected question timestamps
        │
        ▼
build_mock_map.py     → joins timestamps to "MOCK-XX" labels
        │
        ▼
git commit + push     → web/data/mock-timestamp-map.json updated on GitHub Pages
        │
        ▼ (hourly alarm, or next question save if cache is stale)
Extension fetches the new map in the background
        │
        ▼
Saving a question on that mock auto-attaches its solution timestamp
```

Nothing here needs a local server, a manual import, or you running a script
by hand after the initial setup — the only trigger left is uploading a new
mock video to the playlist.

## Notes / next steps

- For long videos, `analyze_questions.py` sends the whole transcript in one
  call. If you hit token limits, chunk the transcript (e.g. by 20-minute
  windows) and merge the returned question lists, adjusting `number`
  sequentially.
- The AI step can occasionally mislabel a sub-step as a new question —
  spot-check the JSON before publishing, or add a lightweight admin view to
  the site for manually nudging timestamps.
- Add quiz options/answers by extending each question object with an
  `options` and `correct_answer` field, and rendering a real answer-choice
  UI above the "Show solution" button.
