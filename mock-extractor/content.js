// Mock Extractor - content script (v1.9)
// - Floating panel at bottom-right of the live mock page
// - Captures Parmar + Testbook with strict option filtering (no duplicate /
//   stat-row "ghost" options) and de-duplication by content hash
// - Extracts per-question "Your time" + "Avg time"
// - Manual capture ONLY: nothing is saved until the user clicks
//   "Save this question" (panel / popup). No auto-capture on scroll/DOM change.
// - Storage is a SINGLE GLOBAL bucket (not per-URL) so questions saved on one
//   mock stay put when you navigate to / open a different mock, letting you
//   build up and export questions from several mocks in one go. Only an
//   explicit "Clear all" removes them.

(function () {
  if (window.__mockExtractorLoaded) return;
  window.__mockExtractorLoaded = true;
  if (window.top !== window) return; // run only in the top frame

  const STORAGE_KEY = "mockExtractor::global";
  let lastSavedSignature = "";
  let lastSavedAt = 0;

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  // ---------- Normalization helpers ----------
  // Produce a stable text+image fingerprint that ignores style blocks,
  // bistream attributes, classes/ids/styles, and angular bookkeeping.
  function normFingerprint(htmlString) {
    const div = document.createElement("div");
    div.innerHTML = htmlString || "";
    div.querySelectorAll("style, script").forEach((n) => n.remove());
    div.querySelectorAll("*").forEach((el) => {
      ["bis_skin_checked", "class", "id", "style"].forEach((a) => el.removeAttribute(a));
      Array.from(el.attributes).forEach((a) => {
        if (a.name.startsWith("ng-") || a.name.startsWith("data-state")) {
          el.removeAttribute(a.name);
        }
      });
    });
    const txt  = (div.textContent || "").replace(/\s+/g, " ").trim();
    const imgs = Array.from(div.querySelectorAll("img"))
      .map((i) => i.getAttribute("src") || "").join("|");
    return txt + "##" + imgs;
  }

  // Per-option dedup key — used INSIDE one question to detect repeated options.
  // Strips style/script (RBE/Parmar render the same <style> block in every
  // option, which made textContent identical and collapsed all options to one).
  function optionKey(labelEl) {
    if (!labelEl) return "";
    const clone = labelEl.cloneNode(true);
    clone.querySelectorAll("style, script").forEach((n) => n.remove());
    const txt  = (clone.textContent || "").replace(/\s+/g, " ").trim();
    const imgs = Array.from(clone.querySelectorAll("img"))
      .map((i) => i.getAttribute("src") || "").join("|");
    return txt + "|" + imgs;
  }

  // ---------- Timing ----------
  function captureTiming() {
    const t = { you: "", avg: "" };

    // Parmar:  <div class="text-right text-sm">Your Time: <span>24s</span></div>
    $$("div.text-right.text-sm").forEach((d) => {
      const span = d.querySelector("span");
      if (!span) return;
      const txt = (d.textContent || "").trim();
      if (/^your\s*time/i.test(txt))    t.you = span.textContent.trim();
      if (/^average\s*time/i.test(txt)) t.avg = span.textContent.trim();
    });
    if (t.you || t.avg) return t;

    // Testbook:  <div class="d-inline-block ..."><span>You:</span> <span>00:07</span></div>
    $$("div.d-inline-block").forEach((d) => {
      const spans = d.querySelectorAll("span");
      if (spans.length < 2) return;
      const lbl = (spans[0].textContent || "").trim();
      const val = (spans[1].textContent || "").trim();
      if (/^you:?$/i.test(lbl)  && !t.you) t.you = val;
      if (/^avg:?$/i.test(lbl)  && !t.avg) t.avg = val;
    });
    return t;
  }

  // ---------- Parmar adapter ----------
  function captureParmarStyle() {
    const container = $("#question-container") || $("#questionContainer");
    if (!container) return null;

    const numEl = container.querySelector("#question-number");
    const m = numEl ? (numEl.textContent || "").match(/(\d+)/) : null;
    const number = m ? parseInt(m[1], 10) : 0;

    const contentEl = container.querySelector("#question-content")
                   || container.querySelector(".question-content");
    const questionHtml = contentEl ? contentEl.innerHTML.trim() : "";

    // Parmar uses [id="question-option-single"]; sibling MCQ platform
    // (same Tailwind shell) uses [id="question-option-multiple"]. Accept both.
    const optEls = $$(
      '[id="question-option-single"], [id="question-option-multiple"]',
      container
    );
    const seen = new Set();
    const options = [];
    let correctIdx = -1;
    optEls.forEach((optDiv) => {
      const labelEl = optDiv.querySelector('[id="question-option-single-label"]')
                   || optDiv.querySelector('[id="question-option-multiple-label"]')
                   || optDiv.querySelector("label");
      const html = labelEl ? labelEl.innerHTML.trim() : "";
      const key  = optionKey(labelEl);
      if (!html || !key || key === "|" || seen.has(key)) return;
      seen.add(key);
      // bg-green-100 = Parmar correct marker; bg-success = new platform's marker.
      const isCorrect = optDiv.classList.contains("bg-green-100")
                     || optDiv.classList.contains("bg-success");
      if (isCorrect && correctIdx === -1) correctIdx = options.length;
      options.push({ html, correct: isCorrect });
    });
    if (!questionHtml || !options.length) return null;

    let solutionHtml = "";
    $$("div.font-bold.text-green-700").some((h) => {
      const t = (h.textContent || "").trim().toLowerCase();
      if (t.startsWith("solution") && h.parentElement) {
        solutionHtml = h.parentElement.innerHTML.trim();
        return true;
      }
      return false;
    });

    // Fallback: parse "correct answer is …" from solution text and remap.
    if (correctIdx === -1) {
      const idx = detectCorrectFromSolution(solutionHtml, options);
      if (idx >= 0) {
        correctIdx = idx;
        options[idx].correct = true;
      }
    }

    return {
      number, questionHtml, options, correctIdx, solutionHtml,
      timing: captureTiming(),
      capturedAt: Date.now(),
      source: "parmar",
    };
  }

  // ---------- Correct-option detection helpers ----------
  // Some Testbook variants use class names other than `correct-option` (e.g.
  // `correct`, `right-option`, `bg-success`) or mark the LI with an inline
  // attribute. Probe all of them, plus tick/check icons inside the LI.
  function liLooksCorrect(li) {
    if (!li) return false;
    const cls = li.className || "";
    if (/\b(correct-option|correct|right-option|bg-success|is-correct|right-answer|correctly-answered)\b/i.test(cls)) {
      return true;
    }
    if (li.getAttribute && (
      li.getAttribute("data-correct") === "true" ||
      li.getAttribute("data-iscorrect") === "true" ||
      li.getAttribute("data-is-correct") === "true"
    )) return true;
    // Tick / check / success icons used by Testbook to flag the right answer.
    if (li.querySelector('.fa-check, .fa-check-circle, .icon-correct, .icon-tick, [class*="correct-tick"], [class*="correct-icon"]')) {
      return true;
    }
    // Inline style green border / green background is also a strong hint.
    const inline = (li.getAttribute && li.getAttribute("style")) || "";
    if (/border[^;]*(?:#0a0|#080|green|#16a34a|#22c55e)/i.test(inline)) return true;
    return false;
  }

  // Fallback: parse "correct answer is X" / "Answer: X" from the solution HTML
  // and map it back to an option index. Used when DOM markers are missing.
  function detectCorrectFromSolution(solutionHtml, options) {
    if (!solutionHtml || !options || !options.length) return -1;
    const tmp = document.createElement("div");
    tmp.innerHTML = solutionHtml;
    tmp.querySelectorAll("style, script").forEach((n) => n.remove());
    const text = (tmp.textContent || "").replace(/\s+/g, " ").trim();
    if (!text) return -1;

    const patterns = [
      /correct\s+(?:answer|option|response|choice)\s+is[:\s]+([^.\n]{1,120})/i,
      /(?:answer|ans)[\s:]+\(?\s*([A-Da-d])\s*\)?(?:\b|$)/,
      /∴\s*the\s+correct\s+answer\s+is[:\s]+([^.\n]{1,120})/i,
      /hence,?\s+(?:the\s+)?correct\s+(?:answer|option)\s+is[:\s]+([^.\n]{1,120})/i,
    ];
    let raw = null;
    for (const re of patterns) {
      const m = text.match(re);
      if (m) { raw = m[1]; break; }
    }
    if (!raw) return -1;
    const cleaned = raw.replace(/[*_∴.,;:!]/g, " ").replace(/\s+/g, " ").trim();

    // Letter form: "A", "(B)", "C."
    const letterM = cleaned.match(/^[(\[]?\s*([A-Da-d])\s*[)\].]?\s*$/);
    if (letterM) {
      const idx = letterM[1].toLowerCase().charCodeAt(0) - 97;
      if (idx >= 0 && idx < options.length) return idx;
    }

    // Value form: compare normalized option text against the captured answer.
    const norm = (s) => (s || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/[\s,]+/g, " ")
      .trim()
      .toLowerCase();
    const target = norm(cleaned);
    let best = -1, bestScore = 0;
    for (let i = 0; i < options.length; i++) {
      const ot = norm(options[i].html);
      if (!ot) continue;
      if (ot === target) return i;
      if (target.indexOf(ot) >= 0 || ot.indexOf(target) >= 0) {
        const score = Math.min(ot.length, target.length);
        if (score > bestScore) { bestScore = score; best = i; }
      }
    }
    return best;
  }

  // ---------- Testbook adapter ----------
  // Strict option filtering: only `ul.list-unstyled.clearfix` (MCQ list), drop
  // stat rows like "My Answer: 3", "Your first attempt", "N% answered correctly".
  function captureTestbookStyle() {
    const root = $(".que-ans-box");
    if (!root) return null;

    let qBox = root.querySelector('div.qns-view-box[ng-bind-html*="getQuestionDesc"]');
    if (!qBox) qBox = root.querySelector("div.qns-view-box");
    const questionHtml = qBox ? qBox.innerHTML.trim() : "";

    const optList = root.querySelector("ul.list-unstyled.clearfix");
    if (!questionHtml || !optList) return null;

    const optEls = Array.from(optList.children).filter(
      (el) => el.tagName === "LI"
           && el.classList.contains("option")
           && !el.classList.contains("ng-hide")
    );

    const seen = new Set();
    const options = [];
    let correctIdx = -1;
    optEls.forEach((li) => {
      // Real options have <label><div class="qns-view-box">…</div></label>.
      // Stat rows have a bare <label><div class="ng-binding">My Answer: 3</div></label>.
      const lbl = li.querySelector("label > div.qns-view-box");
      if (!lbl) return;
      const html = lbl.innerHTML.trim();
      const key  = optionKey(lbl);
      const txtOnly = (lbl.textContent || "").replace(/\s+/g, " ").trim();
      if (!key || key === "|") return;
      if (/^my\s*answer:/i.test(txtOnly))            return;
      if (/^your\s*first\s*attempt$/i.test(txtOnly)) return;
      if (/^not\s*attempted$/i.test(txtOnly))        return;
      if (/^\d+%\s*answered\s*correctly$/i.test(txtOnly)) return;
      if (seen.has(key)) return;
      seen.add(key);

      const isCorrect = liLooksCorrect(li);
      if (isCorrect && correctIdx === -1) correctIdx = options.length;
      options.push({ html, correct: isCorrect });
    });
    if (!options.length) return null;

    let solutionHtml = "";
    const solBox = root.querySelector('div.qns-view-box[ng-bind-html*="getSolutionDesc"]');
    if (solBox) solutionHtml = solBox.innerHTML.trim();

    // Fallback: parse "correct answer is …" from solution text and remap.
    if (correctIdx === -1) {
      const idx = detectCorrectFromSolution(solutionHtml, options);
      if (idx >= 0) {
        correctIdx = idx;
        options[idx].correct = true;
      }
    }

    // Question number
    let number = 0;
    const numEl = document.querySelector(".tp-ques-number")
               || document.querySelector(".question-number-box")
               || document.querySelector(".que-num");
    if (numEl) {
      const m = (numEl.textContent || "").match(/(\d+)/);
      if (m) number = parseInt(m[1], 10);
    }

    return {
      number, questionHtml, options, correctIdx, solutionHtml,
      timing: captureTiming(),
      capturedAt: Date.now(),
      source: "testbook",
    };
  }

  function captureQuestion() {
    return captureParmarStyle() || captureTestbookStyle();
  }

  // ---------- Storage / dedup ----------
  function hashOf(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  // ---------- Mock label (e.g. "MOCK-09") ----------
  // Primary: the page's own title chip -
  //   <div class="mx-auto text-foreground text-center text-lg font-bold hidden md:block">MOCK-09</div>
  // Fallback: parse it out of document.title (e.g. "Mock Test - 9 | Parmar Academy").
  function captureMockLabel() {
    const chip = $(".mx-auto.text-foreground.text-center.text-lg.font-bold");
    const chipTxt = chip ? (chip.textContent || "").trim() : "";
    const fromChip = chipTxt.match(/MOCK[\s\-_]*0*(\d+)/i);
    if (fromChip) return "MOCK-" + fromChip[1].padStart(2, "0");

    const fromTitle = (document.title || "").match(/MOCK[\s\-_]*0*(\d+)/i);
    if (fromTitle) return "MOCK-" + fromTitle[1].padStart(2, "0");

    return null;
  }

  // ---------- Video timestamp map (auto-synced from a hosted URL) ----------
  // The map is built automatically by build_mock_map.py + committed by a
  // GitHub Actions workflow, then served as a plain JSON file (e.g. via
  // GitHub Pages). The extension fetches it in the background and caches
  // it locally, refreshing whenever the cache is older than MAP_TTL_MS -
  // no manual import step needed after the URL is set once.
  const MAP_URL_KEY   = "mockExtractor::videoMapUrl";
  const MAP_CACHE_KEY = "mockExtractor::videoMapCache";
  const MAP_TIME_KEY  = "mockExtractor::videoMapSyncedAt";
  const MAP_TTL_MS    = 3 * 60 * 60 * 1000; // refresh at most every 3 hours

  async function getVideoMap({ forceRefresh = false } = {}) {
    const stored = await chrome.storage.local.get([MAP_URL_KEY, MAP_CACHE_KEY, MAP_TIME_KEY]);
    const url = stored[MAP_URL_KEY];
    const cached = stored[MAP_CACHE_KEY] || {};
    const syncedAt = stored[MAP_TIME_KEY] || 0;
    const isStale = Date.now() - syncedAt > MAP_TTL_MS;

    if (!url) return cached; // never configured - lookups just no-op

    if (!forceRefresh && !isStale) return cached;

    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const fresh = await res.json();
      await chrome.storage.local.set({
        [MAP_CACHE_KEY]: fresh,
        [MAP_TIME_KEY]: Date.now(),
      });
      return fresh;
    } catch (e) {
      // Fetch failed (offline, URL not set up yet, etc.) - fall back to
      // whatever we cached last time rather than losing timestamps.
      return cached;
    }
  }

  async function attachVideoTimestamp(q) {
    if (!q.mockLabel || !q.number) return q;
    const map = await getVideoMap();
    const entry = map[q.mockLabel];
    if (!entry) return q;
    const ts = entry.questions && entry.questions[String(q.number)];
    if (!ts) return q;
    q.videoId = entry.videoId;
    q.videoStart = ts.start;
    q.videoEnd = ts.end || null;
    return q;
  }

  // Tag every question with which mock it came from, so a combined export
  // spanning multiple mocks can still be told apart later if needed.
  function tagSource(q) {
    q.sourceUrl = location.href;
    q.sourceTitle = document.title;
    q.mockLabel = captureMockLabel();
    return q;
  }

  async function saveQuestion(q) {
    // Stable hash: ignore style/script, dynamic attributes, and re-render noise.
    // Same question → same qid even after Angular re-renders.
    const qFinger = normFingerprint(q.questionHtml);
    const oFinger = q.options.map((o) => normFingerprint(o.html)).join("|");
    const qid = "q_" + hashOf(qFinger + "||" + oFinger);

    // Guard against a double-fire from a fast double-click on the button,
    // not against normal re-saves of the same question later on.
    const now = Date.now();
    if (qid === lastSavedSignature && now - lastSavedAt < 800) return null;
    lastSavedSignature = qid;
    lastSavedAt = now;

    tagSource(q);
    await attachVideoTimestamp(q);

    const data = await chrome.storage.local.get(STORAGE_KEY);
    // Global bucket: accumulates questions across every mock/tab until the
    // user explicitly clears it. Never scoped to just this page's URL.
    const bucket = data[STORAGE_KEY] || {
      title: "Captured Questions",
      questions: {}, order: [], createdAt: Date.now(),
    };
    if (!bucket.order) bucket.order = Object.keys(bucket.questions);

    const isNew = !(qid in bucket.questions);
    if (isNew) bucket.order.push(qid);

    // Merge: keep the richer copy (with solution / correctIdx / timing).
    const prev = bucket.questions[qid];
    if (prev) {
      if (!q.solutionHtml && prev.solutionHtml) q.solutionHtml = prev.solutionHtml;
      if (q.correctIdx < 0 && prev.correctIdx >= 0) q.correctIdx = prev.correctIdx;
      if (!q.timing?.you && prev.timing?.you) q.timing.you = prev.timing.you;
      if (!q.timing?.avg && prev.timing?.avg) q.timing.avg = prev.timing.avg;
      if (!q.number && prev.number) q.number = prev.number;
    }
    bucket.questions[qid] = q;
    bucket.updatedAt = Date.now();
    await chrome.storage.local.set({ [STORAGE_KEY]: bucket });

    updatePanel(Object.keys(bucket.questions).length, true);
    return { isNew, count: Object.keys(bucket.questions).length };
  }

  // Detection only — checks whether a question is currently rendered on the
  // page so the panel can appear and the Save button has something to save.
  // Does NOT write to storage. Nothing is captured until the user clicks
  // "Save this question" (or the popup's "Save current question").
  function detectCurrentQuestion() {
    try {
      return captureQuestion();
    } catch (e) {
      console.warn("[MockExtractor]", e);
      return null;
    }
  }

  function detectTick() {
    const q = detectCurrentQuestion();
    if (q) {
      ensurePanel();
      // Reflect the true saved count (from storage), not this detection.
      chrome.storage.local.get(STORAGE_KEY).then((d) => {
        const b = d[STORAGE_KEY];
        updatePanel(b ? Object.keys(b.questions).length : 0, false);
      });
    }
  }

  // Explicit save — called only from a direct user action (panel button or
  // popup button), never from the mutation observer / timers.
  async function saveCurrentQuestion() {
    ensurePanel();
    const q = detectCurrentQuestion();
    if (!q) {
      flashToast("No question detected here");
      return { ok: false };
    }
    const res = await saveQuestion(q);
    if (!res) { flashToast("Already saved"); return { ok: true, dup: true }; }
    return { ok: true };
  }

  function flashToast(msg) {
    if (!toastEl) return;
    const prev = toastEl.textContent;
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.remove("show");
      setTimeout(() => { toastEl.textContent = prev; }, 200);
    }, 1100);
  }

  // ---------- Floating panel (draggable + hide/minimize) ----------
  let panel, countEl, toastEl, toastTimer, miniFab;
  function ensurePanel() {
    if (panel) return;

    // --- Mini FAB (shown when panel is hidden) ---
    miniFab = document.createElement("div");
    miniFab.id = "__mockExtractorFab";
    miniFab.innerHTML = `
<style>
  #__mockExtractorFab { all:initial; position:fixed; right:16px; bottom:16px;
    z-index:2147483647; width:40px; height:40px; border-radius:50%;
    background:#2563eb; color:#fff; display:none; align-items:center;
    justify-content:center; cursor:pointer; box-shadow:0 4px 12px rgba(0,0,0,.25);
    font:700 18px/1 sans-serif; user-select:none; }
  #__mockExtractorFab:hover { transform:scale(1.1); }
  #__mockExtractorFab .fab-badge { position:absolute; top:-4px; right:-4px;
    background:#16a34a; color:#fff; font-size:10px; min-width:16px; height:16px;
    border-radius:8px; display:flex; align-items:center; justify-content:center;
    padding:0 4px; }
</style>
<span>M</span><span class="fab-badge" id="__mep-fab-badge">0</span>`;
    document.body.appendChild(miniFab);
    miniFab.addEventListener("click", () => {
      panel.style.display = "";
      miniFab.style.display = "none";
    });

    // --- Main panel ---
    panel = document.createElement("div");
    panel.id = "__mockExtractorPanel";
    panel.innerHTML = `
<style>
  #__mockExtractorPanel { all: initial; position:fixed; right:16px; bottom:16px;
    z-index:2147483647; font:13px/1.4 -apple-system, system-ui, sans-serif; color:#111;
    background:#fff; border:1px solid #e5e7eb; border-radius:10px;
    box-shadow:0 10px 25px rgba(0,0,0,.15); width:240px; overflow:visible;
    box-sizing:border-box; }
  #__mockExtractorPanel * { box-sizing:border-box; font-family:inherit; }
  #__mockExtractorPanel .mep-head { display:flex; align-items:center; gap:6px;
    padding:8px 12px; background:#2563eb; color:#fff; cursor:grab;
    user-select:none; border-radius:9px 9px 0 0; }
  #__mockExtractorPanel.collapsed .mep-head { border-radius:9px; }
  #__mockExtractorPanel .mep-head strong { flex:1; font-size:13px; font-weight:600; }
  #__mockExtractorPanel .mep-count { background:rgba(255,255,255,.22);
    padding:1px 8px; border-radius:10px; font-weight:600; font-size:12px; }
  #__mockExtractorPanel .mep-arrow { font-size:12px; transition:transform .15s; cursor:pointer; }
  #__mockExtractorPanel.collapsed .mep-arrow { transform:rotate(-90deg); }
  #__mockExtractorPanel .mep-hide { font-size:14px; cursor:pointer; opacity:.8;
    padding:2px 4px; line-height:1; }
  #__mockExtractorPanel .mep-hide:hover { opacity:1; }
  #__mockExtractorPanel .mep-body { padding:10px 12px; display:flex; flex-direction:column; gap:6px; background:#fff; border-radius:0 0 9px 9px;}
  #__mockExtractorPanel.collapsed .mep-body { display:none; }
  #__mockExtractorPanel button { padding:7px 10px; border:1px solid #d1d5db;
    background:#f9fafb; border-radius:5px; cursor:pointer; font-size:12.5px;
    color:#111; text-align:center; }
  #__mockExtractorPanel button:hover { background:#f3f4f6; }
  #__mockExtractorPanel button.primary { background:#16a34a; color:#fff; border-color:#16a34a; }
  #__mockExtractorPanel button.primary:hover { background:#15803d; }
  #__mockExtractorPanel button.danger { color:#b91c1c; border-color:#fca5a5; background:#fff; }
  #__mockExtractorPanel .mep-toast { position:absolute; right:10px; top:-22px;
    background:#16a34a; color:#fff; padding:2px 10px; border-radius:10px; font-size:11px;
    opacity:0; transform:translateY(6px); transition:opacity .18s, transform .18s;
    pointer-events:none; }
  #__mockExtractorPanel .mep-toast.show { opacity:1; transform:translateY(0); }
  #__mockExtractorPanel.dragging .mep-head { cursor:grabbing; }
</style>
<div class="mep-head">
  <strong>Mock Extractor</strong>
  <span class="mep-count" id="__mep-count">0</span>
  <span class="mep-arrow" id="__mep-toggle" title="Collapse">&#x25BE;</span>
  <span class="mep-hide" id="__mep-hide" title="Hide panel (click floating icon to restore)">&#x2715;</span>
</div>
<div class="mep-toast" id="__mep-toast">Saved +1</div>
<div class="mep-body">
  <button class="primary" id="__mep-capture">Save this question</button>
  <button id="__mep-preview">Preview &amp; Save</button>
  <button class="danger" id="__mep-clear">Clear all</button>
</div>`;
    document.body.appendChild(panel);
    countEl = panel.querySelector("#__mep-count");
    toastEl = panel.querySelector("#__mep-toast");

    // --- Collapse toggle ---
    panel.querySelector("#__mep-toggle").addEventListener("click", (e) => {
      e.stopPropagation();
      panel.classList.toggle("collapsed");
    });

    // --- Hide button (minimize to FAB) ---
    panel.querySelector("#__mep-hide").addEventListener("click", (e) => {
      e.stopPropagation();
      panel.style.display = "none";
      miniFab.style.display = "flex";
    });

    // --- Drag logic ---
    let isDragging = false, dragMoved = false, startX, startY, origLeft, origTop;
    const head = panel.querySelector(".mep-head");
    head.addEventListener("mousedown", (e) => {
      if (e.target.closest("#__mep-toggle, #__mep-hide")) return;
      isDragging = true; dragMoved = false;
      startX = e.clientX; startY = e.clientY;
      const rect = panel.getBoundingClientRect();
      origLeft = rect.left; origTop = rect.top;
      panel.classList.add("dragging");
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragMoved = true;
      panel.style.left = (origLeft + dx) + "px";
      panel.style.top  = (origTop + dy) + "px";
      panel.style.right = "auto";
      panel.style.bottom = "auto";
    });
    document.addEventListener("mouseup", () => {
      if (isDragging) {
        isDragging = false;
        panel.classList.remove("dragging");
      }
    });

    // --- Buttons ---
    panel.querySelector("#__mep-capture").addEventListener("click", (e) => {
      e.stopPropagation(); saveCurrentQuestion();
    });
    panel.querySelector("#__mep-clear").addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("Clear ALL saved questions (across every mock, not just this one)? This can't be undone.")) return;
      await chrome.storage.local.remove(STORAGE_KEY);
      lastSavedSignature = "";
      updatePanel(0, false);
    });
    panel.querySelector("#__mep-preview").addEventListener("click", (e) => {
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: "openPreview", key: STORAGE_KEY });
    });
  }

  function updatePanel(n, flash) {
    if (!panel) return;
    countEl.textContent = n;
    const fabBadge = document.getElementById("__mep-fab-badge");
    if (fabBadge) fabBadge.textContent = n;
    if (flash && toastEl) {
      toastEl.classList.add("show");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastEl.classList.remove("show"), 900);
    }
  }

  // Restore panel state on load. The bucket is global, so if there are ANY
  // previously-saved questions (from this mock or another one), show the
  // panel immediately with the running total.
  chrome.storage.local.get(STORAGE_KEY).then((d) => {
    const b = d[STORAGE_KEY];
    if (b && Object.keys(b.questions).length) {
      ensurePanel();
      updatePanel(Object.keys(b.questions).length, false);
    }
  });

  // Observer + initial pass — DETECTION ONLY. This makes the panel appear
  // (and keeps its count accurate) as soon as a question renders on the
  // page, but it never writes anything to storage by itself. Capturing a
  // question always requires an explicit click on "Save this question"
  // (panel) or "Save current question" (popup).
  let timer = null;
  const obs = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(detectTick, 350);
  });
  obs.observe(document.body, { childList: true, subtree: true, characterData: true });
  setTimeout(detectTick, 1200);

  // Popup messaging
  chrome.runtime.onMessage.addListener((msg, _s, send) => {
    if (msg?.type === "getStatus") {
      chrome.storage.local.get(STORAGE_KEY).then((d) => {
        const b = d[STORAGE_KEY] || { questions: {} };
        send({ ok: true, count: Object.keys(b.questions).length, key: STORAGE_KEY,
               url: location.href, title: document.title });
      });
      return true;
    }
    // Explicit save request from the popup's "Save current question" button.
    if (msg?.type === "capture") {
      saveCurrentQuestion().then((res) => send(res || { ok: false }));
      return true;
    }
  });
})();
