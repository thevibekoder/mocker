# Mock Extractor (Chrome / Edge extension)

Manually save the questions you care about from a Testbook / Parmar Academy /
RBE mock test as you walk through it, then preview and download them as a
single, printable HTML file with **Show Answer**, **Show Solution**,
**All Answers**, **All Solutions**, and **Save** buttons.

Nothing is captured automatically — you choose which questions to save, one
click at a time. Saved questions are kept in one shared pool, so you can
open several different mocks (over several visits) and save questions from
each one before doing a single combined **Preview & Save**.

## Install

1. Unzip `mock-extractor.zip`.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Toggle **Developer mode** (top-right).
4. Click **Load unpacked** and pick the unzipped folder.
5. Pin the **Mock Extractor** icon to your toolbar (optional).

## Use

1. Open the mock on Parmar Academy or Testbook.
2. A small **Mock Extractor** panel appears in the bottom-right of the page
   once a question is on screen.
3. On each question you want to keep, click **Save this question** on the
   panel (or **Save current question** in the popup). A `Saved +1` chip
   flashes and the count ticks up. Questions you don't click Save on are
   never stored.
4. Switch mocks, close the tab, come back later &mdash; already-saved
   questions stay put. Save questions from as many different mocks as you
   like; they all land in the same pool.
5. When done, click **Preview & Save** on the panel (or in the popup).
6. A new tab opens with the rendered HTML &mdash; review it, then click
   **Save as HTML** at the top to download. The saved pool is *not* cleared
   by downloading &mdash; use **Clear all** on the panel/popup when you
   actually want to empty it.
7. To post the questions straight into a Telegram group as native quizzes,
   click **Send to Telegram** in that same preview tab (see below).

## Send to Telegram

The **Send to Telegram** button (in the Preview & Save tab) posts questions
into your group. Pick a mode when sending:

- **Quiz** &mdash; a native Telegram quiz poll per question, auto-graded,
  correct option pre-marked, solution attached as the poll's "explanation".
  Telegram **permanently locks each person's vote after their first
  answer** for quiz polls &mdash; there is no reattempt for this mode, and
  it can't be worked around from our side; it's enforced by Telegram itself.
- **Practice** &mdash; a *regular* (non-quiz) poll instead. Telegram lets
  people change their vote on a regular poll as many times as they want, so
  this is how you get reattempts. Since regular polls don't auto-grade, the
  correct answer + explanation are sent as a **separate follow-up message**
  hidden behind a tap-to-reveal spoiler, so people can vote (and re-vote)
  before peeking.

Rich text (bold, italic, underline, strikethrough, code): native Telegram
polls only ever accept plain text for their question/options &mdash; that's
a hard Bot API limitation with no workaround. To get as close as possible,
Quiz/Practice poll text is rendered with **Unicode "styled" letters**
(genuinely different characters that look bold/italic/monospace) rather
than real formatting. Anywhere Telegram *does* support real HTML &mdash;
the Practice mode's spoiler answer-reveal message &mdash; bold, italic,
underline, strikethrough, code, and links are carried over properly.
Images inside a question/option show up as `[image]` since neither polls
nor plain messages can embed them from a URL that isn't reachable.

Setup (one-time):
1. In Telegram, message **@BotFather**, send `/newbot`, and copy the bot
   token it gives you.
2. Add that bot to your Telegram group as a member.
3. Get the group's chat ID &mdash; forward any message from the group to
   **@userinfobot** or **@getidsbot**. Group IDs usually look like
   `-1001234567890`.
4. Paste the token + chat ID into the dialog the button opens the first
   time. They're saved locally (`chrome.storage.local`, this device only)
   so you won't need to re-enter them.

Notes:
- Long questions/options/solutions get truncated to Telegram's limits (300
  / 100 / 200 characters for polls; ~3800 for the practice-mode reveal
  message).
- A question is skipped (and listed before sending) if it has fewer than 2
  or more than 10 options; Quiz mode additionally requires a detected
  correct answer (Practice mode doesn't, since it has no auto-grading).
- Sends are sequential with a short pause between each to stay under
  Telegram's rate limits; if Telegram asks to slow down, it waits and
  retries automatically.
- This feature only exists in the live Preview & Save tab, not in the
  downloaded standalone HTML file, so your bot token never ends up baked
  into a file you might share.

## What's captured

- Question text (HTML preserved &mdash; images, math, formatting).
- Options (de-duplicated; Testbook stat rows like `My Answer: 3`,
  `Your first attempt`, `64% answered correctly` are filtered out).
- Correct option (highlighted green when **Show Answer** is clicked).
- Solution HTML.
- Your time and average time per question (shown as chips next to the
  question number).

## Notes

- Both adapters run on every page; whichever matches first wins.
  RBE uses the same DOM layout as Parmar Academy so the Parmar adapter
  handles it automatically.
- Capturing is 100% manual. The panel/popup only ever save a question when
  you click **Save this question** / **Save current question** &mdash;
  scrolling, navigating, or the page re-rendering never saves anything by
  itself.
- All saved questions live in a **single shared pool** in
  `chrome.storage.local` (not per-mock, not per-URL), so they survive
  navigating away, closing the tab, or opening a different mock. Only
  clicking **Clear all** (on the floating panel or in the popup) empties
  the pool &mdash; clicking **Preview & Save** / **Save as HTML** never
  clears it.
- Math/LaTeX in the exported HTML renders via MathJax CDN (online).
- The exported `Save as HTML` button downloads the page with whatever you
  have currently revealed.

## Files

```
manifest.json   MV3 manifest
background.js   opens the preview tab
content.js      runs on every page; captures and shows the floating panel
preview.html    target of the preview tab
preview.js      reads the storage bucket and renders the export
popup.html      toolbar popup (optional / backup UI)
popup.js        popup logic
```
