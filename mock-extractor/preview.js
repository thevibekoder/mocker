// Preview tab — renders the captured questions into THIS page using normal
// DOM (no document.write). Buttons work natively. The "Save as HTML" button
// produces a fully self-contained file with its own embedded script.

const STATE = { bucket: null, qs: [], title: "", key: "" };

(async function init() {
  const params = new URLSearchParams(location.search);
  const key = params.get("key");
  const status = document.getElementById("status");
  if (!key) return fail("Missing storage key.");
  STATE.key = key;

  const data = await chrome.storage.local.get(key);
  const bucket = data[key];
  if (!bucket || !Object.keys(bucket.questions || {}).length) {
    return fail("No questions saved yet. Open a mock, click \"Save this question\" on each one you want, then come back here.");
  }

  // Order questions and tag each with its storage qid (_qid) for delete ops.
  let qs;
  if (Array.isArray(bucket.order) && bucket.order.length) {
    qs = bucket.order
      .map((k) => bucket.questions[k] && Object.assign({}, bucket.questions[k], { _qid: k }))
      .filter(Boolean);
  } else {
    qs = Object.entries(bucket.questions)
      .map(([k, q]) => Object.assign({}, q, { _qid: k }))
      .sort((a, b) => (a.number || 0) - (b.number || 0));
  }
  qs.forEach((q, i) => { if (!q.number || q.number <= 0) q.number = i + 1; });

  // Retroactive fix: if a question was captured before correctIdx detection
  // was improved, try to recover the correct option from its solution text.
  qs.forEach((q) => {
    if (q.correctIdx >= 0) return;
    const idx = recoverCorrectIdxFromSolution(q.solutionHtml, q.options);
    if (idx >= 0) {
      q.correctIdx = idx;
      if (q.options[idx]) q.options[idx].correct = true;
    }
  });

  STATE.bucket = bucket;
  STATE.qs = qs;
  STATE.title = bucket.title || "Mock Test";
  render();
})();

function fail(msg) {
  const s = document.getElementById("status");
  s.classList.add("err");
  s.textContent = msg;
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"]/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[c]));
}

// Mirrors content.js detectCorrectFromSolution — used to retroactively
// repair captures made before correctIdx detection was widened.
function recoverCorrectIdxFromSolution(solutionHtml, options) {
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
  const letterM = cleaned.match(/^[(\[]?\s*([A-Da-d])\s*[)\].]?\s*$/);
  if (letterM) {
    const idx = letterM[1].toLowerCase().charCodeAt(0) - 97;
    if (idx >= 0 && idx < options.length) return idx;
  }
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

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const k in attrs) {
    if (k === "class") n.className = attrs[k];
    else if (k === "html") n.innerHTML = attrs[k];
    else if (k.startsWith("on") && typeof attrs[k] === "function") n.addEventListener(k.slice(2), attrs[k]);
    else n.setAttribute(k, attrs[k]);
  }
  children.flat().forEach((c) => {
    if (c == null) return;
    if (typeof c === "string") n.appendChild(document.createTextNode(c));
    else n.appendChild(c);
  });
  return n;
}

function render() {
  document.body.innerHTML = "";
  sortMainByTime._original = null;  // forget previous snapshot

  // ---------- Header ----------
  const titleInput = el("input", {
    class: "title-input",
    type: "text",
    value: STATE.title,
    placeholder: "Mock title",
  });
  titleInput.addEventListener("input", () => { STATE.title = titleInput.value; });

  const sortSelect = el("select", {
    class: "sort-select",
    id: "previewSortByTime",
    title: "Sort questions by your time",
  });
  ["default", "asc", "desc"].forEach((v, i) => {
    const labels = ["Sort: Default", "Your time \u2191 (low\u2192high)", "Your time \u2193 (high\u2192low)"];
    const o = document.createElement("option");
    o.value = v; o.textContent = labels[i];
    sortSelect.appendChild(o);
  });
  sortSelect.addEventListener("change", () => sortMainByTime(sortSelect.value));

  const header = el("header", {},
    el("div", { class: "titlebox" },
      el("h1", {}, "Mock Title (editable)"),
      titleInput
    ),
    el("div", { class: "meta" }, STATE.qs.length + " questions"),
    el("button", { class: "btn-dup",   onclick: removeDuplicates }, "Remove Duplicates"),
    el("button", { class: "btn-all-a", onclick: showAllAnswers   }, "All Answers"),
    el("button", { class: "btn-all-s", onclick: showAllSolutions }, "All Solutions"),
    sortSelect,
    el("button", { class: "btn-tg",    onclick: startTelegramSend }, "Send to Telegram"),
    el("button", { class: "btn-save",  onclick: saveExport       }, "Save as HTML"),
  );
  document.body.appendChild(header);

  // ---------- Questions ----------
  const main = el("main", { id: "main" });
  STATE.qs.forEach((q) => main.appendChild(renderQuestion(q)));
  document.body.appendChild(main);

  typeset();
}

function videoBlockFor(q) {
  if (!q.videoId || q.videoStart == null) return null;
  let src = `https://www.youtube.com/embed/${q.videoId}?start=${q.videoStart}&rel=0`;
  if (q.videoEnd) src += `&end=${q.videoEnd}`;
  const wrap = el("div", { class: "sol-video" },
    el("iframe", {
      src, frameborder: "0", allowfullscreen: "1",
      allow: "autoplay; encrypted-media",
    }),
    el("div", { class: "sol-video-caption" },
      `From ${q.mockLabel || "video"}, timestamp ${fmtTime(q.videoStart)}`)
  );
  return wrap;
}

function fmtTime(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function renderQuestion(q) {
  const t = q.timing || {};
  const correctLetter = q.correctIdx >= 0
    ? String.fromCharCode(65 + q.correctIdx)
    : "?";

  // Options
  const opts = el("ol", { class: "opts" });
  q.options.forEach((o, i) => {
    const letter = String.fromCharCode(97 + i);
    opts.appendChild(el("li", { "data-correct": o.correct ? "1" : "0" },
      el("span", { class: "letter" }, letter + "."),
      el("span", { class: "opt-html", html: o.html })
    ));
  });

  // Answer block
  const ansBlock = el("div", { class: "ans hidden" },
    el("strong", {}, "Answer: "), document.createTextNode(correctLetter));

  // Solution block
  const solBody = el("div", { class: "sol-body" });
  if (q.solutionHtml) {
    solBody.innerHTML = q.solutionHtml;
  } else {
    solBody.innerHTML = "<em>(No solution was visible when this question was captured.)</em>";
  }
  const solBlock = el("div", { class: "sol hidden" },
    el("strong", {}, "Solution"),
    videoBlockFor(q),
    solBody);

  // Buttons
  const btnAns = el("button", { class: "btn-ans" }, "Show Answer");
  const btnSol = el("button", { class: "btn-sol" }, "Show Solution");

  // Per-question delete
  const btnDel = el("button", {
    class: "btn-del",
    title: "Delete this question",
    onclick: (e) => { e.stopPropagation(); deleteQuestion(q._qid); },
  }, "\u00d7");

  // Section
  const section = el("section", { class: "q", "data-num": String(q.number) },
    el("div", { class: "qhead" },
      el("div", { class: "qnum" }, "Question " + q.number),
      el("div", { class: "qmeta" },
        t.you ? el("span", { class: "chip" }, "Your time: " + t.you) : null,
        t.avg ? el("span", { class: "chip chip-avg" }, "Avg: " + t.avg) : null,
      ),
      btnDel,
    ),
    el("div", { class: "qbody", html: q.questionHtml }),
    opts,
    el("div", { class: "btns" }, btnAns, btnSol),
    ansBlock,
    solBlock,
  );

  // Wire button handlers — direct DOM, fully reliable.
  btnAns.addEventListener("click", () => {
    section.classList.toggle("reveal-ans");
    const showing = !ansBlock.classList.contains("hidden");
    if (showing) {
      ansBlock.classList.add("hidden");
      btnAns.textContent = "Show Answer";
    } else {
      ansBlock.classList.remove("hidden");
      btnAns.textContent = "Hide Answer";
    }
  });
  btnSol.addEventListener("click", () => {
    const showing = !solBlock.classList.contains("hidden");
    if (showing) {
      solBlock.classList.add("hidden");
      btnSol.textContent = "Show Solution";
    } else {
      solBlock.classList.remove("hidden");
      btnSol.textContent = "Hide Solution";
      typeset(solBlock);
    }
  });

  return section;
}

function showAllAnswers() {
  document.querySelectorAll(".q").forEach((q) => {
    q.classList.add("reveal-ans");
    const ans = q.querySelector(".ans"); if (ans) ans.classList.remove("hidden");
    const b = q.querySelector(".btn-ans"); if (b) b.textContent = "Hide Answer";
  });
}
function showAllSolutions() {
  document.querySelectorAll(".q").forEach((q) => {
    const s = q.querySelector(".sol"); if (s) s.classList.remove("hidden");
    const b = q.querySelector(".btn-sol"); if (b) b.textContent = "Hide Solution";
  });
  typeset();
}

function parseTimeStr(s) {
  if (!s) return null;
  s = String(s).trim();
  let m = s.match(/(\d+):(\d+):(\d+)/);
  if (m) return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
  m = s.match(/(\d+):(\d+)/);
  if (m) return (+m[1]) * 60 + (+m[2]);
  let sec = 0, had = false;
  m = s.match(/(\d+)\s*m/i); if (m) { sec += (+m[1]) * 60; had = true; }
  m = s.match(/(\d+)\s*s/i); if (m) { sec += (+m[1]);      had = true; }
  if (had) return sec;
  m = s.match(/(\d+)/);
  return m ? (+m[1]) : null;
}

function sortMainByTime(mode) {
  const main = document.getElementById("main");
  if (!main) return;
  const qs = Array.from(main.querySelectorAll(".q"));
  // Snapshot the natural document order once.
  if (!sortMainByTime._original) sortMainByTime._original = qs.slice();
  let arr = sortMainByTime._original.slice();
  if (mode === "asc" || mode === "desc") {
    arr.sort((a, b) => {
      const ca = a.querySelector(".chip"), cb = b.querySelector(".chip");
      const ta = ca ? parseTimeStr(ca.textContent.replace(/your\s*time\s*:?/i, "")) : null;
      const tb = cb ? parseTimeStr(cb.textContent.replace(/your\s*time\s*:?/i, "")) : null;
      if (ta == null && tb == null) return 0;
      if (ta == null) return 1;
      if (tb == null) return -1;
      return mode === "asc" ? ta - tb : tb - ta;
    });
  }
  arr.forEach((q) => main.appendChild(q));
}

function typeset(node) {
  if (window.MathJax && MathJax.typesetPromise) {
    MathJax.typesetPromise(node ? [node] : undefined).catch(() => {});
  }
}

// ---------- Delete / dedupe ----------
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
function questionFingerprint(q) {
  return normFingerprint(q.questionHtml) + "||" +
    (q.options || []).map((o) => normFingerprint(o.html)).join("|");
}

async function persistBucketRemovals(qidsToDelete) {
  const data = await chrome.storage.local.get(STATE.key);
  const bucket = data[STATE.key];
  if (!bucket) return;
  qidsToDelete.forEach((qid) => { delete bucket.questions[qid]; });
  if (Array.isArray(bucket.order)) {
    bucket.order = bucket.order.filter((k) => !qidsToDelete.includes(k));
  }
  bucket.updatedAt = Date.now();
  await chrome.storage.local.set({ [STATE.key]: bucket });
}

async function deleteQuestion(qid) {
  if (!qid) return;
  if (!confirm("Delete this question? This also removes it from the captured set.")) return;
  await persistBucketRemovals([qid]);
  STATE.qs = STATE.qs.filter((q) => q._qid !== qid);
  render();
}

async function removeDuplicates() {
  const seen = new Map();    // fingerprint -> first qid
  const toDelete = [];
  STATE.qs.forEach((q) => {
    const fp = questionFingerprint(q);
    if (seen.has(fp)) toDelete.push(q._qid);
    else seen.set(fp, q._qid);
  });
  if (!toDelete.length) { alert("No duplicate questions detected."); return; }
  if (!confirm("Remove " + toDelete.length + " duplicate question(s)?")) return;
  await persistBucketRemovals(toDelete);
  STATE.qs = STATE.qs.filter((q) => !toDelete.includes(q._qid));
  render();
}

// ---------- Telegram quiz export ----------
// Sends questions to a Telegram group via the Bot API. Lives only in this
// live preview tab (never in the downloaded standalone HTML) because it
// needs a bot token, which we don't want baked into a file you might share.
//
// Telegram polls (native quiz UI) can ONLY hold plain text in their
// question/options fields — that's a hard Bot API restriction, not
// something we can work around with markup. What we CAN do:
//   - approximate bold/italic/underline/strike/monospace using Unicode
//     "styled" letters (real different characters, not formatting) so
//     poll text still looks close to the original where possible.
//   - for anything a poll truly can't express (images, real HTML), fall
//     back to a follow-up plain chat message that supports genuine HTML
//     formatting (bold/italic/code/links/spoiler) via Bot API sendMessage.
//
// Two send modes:
//   "quiz"     — native quiz poll, auto-graded, but Telegram permanently
//                locks each person's vote after their first answer. No
//                reattempts are possible for a quiz poll — that lock is
//                enforced by Telegram itself and the Bot API gives us no
//                way to lift it.
//   "practice" — a regular (non-quiz) poll instead. Telegram lets people
//                change their vote on a regular poll as many times as they
//                like, so this gives you reattempts. Since regular polls
//                don't auto-grade, the correct answer + explanation are
//                sent as a separate follow-up message with the answer
//                hidden behind a tap-to-reveal spoiler, using real HTML
//                formatting (so option text can keep bold/italic/code/
//                links here, unlike inside the poll itself).
const TG_KEY = "mockExtractor::telegramSettings";
const TG_LIMITS = { question: 300, option: 100, explanation: 200, maxOptions: 10, message: 3800 };

async function getTelegramSettings() {
  const d = await chrome.storage.local.get(TG_KEY);
  return d[TG_KEY] || { botToken: "", chatId: "" };
}
async function setTelegramSettings(s) {
  await chrome.storage.local.set({ [TG_KEY]: s });
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function closeTgOverlays() {
  document.querySelectorAll(".tg-overlay").forEach((n) => n.remove());
}
function tgOpen(contentEl) {
  closeTgOverlays();
  const overlay = el("div", { class: "tg-overlay" });
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeTgOverlays(); });
  overlay.appendChild(el("div", { class: "tg-box" }, contentEl));
  document.body.appendChild(overlay);
  return overlay;
}

// ---------- Plain-text extraction (fallback / measuring) ----------
function htmlToPlainText(html) {
  const div = document.createElement("div");
  div.innerHTML = html || "";
  div.querySelectorAll("style, script").forEach((n) => n.remove());
  div.querySelectorAll("br").forEach((n) => n.replaceWith("\n"));
  div.querySelectorAll("p, div, li, tr").forEach((n) => n.append("\n"));
  return (div.textContent || "")
    .replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n").replace(/\n{2,}/g, "\n").trim();
}
function tgTruncate(s, n) {
  s = (s || "").trim();
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "\u2026" : s;
}

// ---------- Unicode "styled text" for poll question/options ----------
// Polls can't carry real formatting, so this substitutes visually distinct
// Unicode letters for bold/italic/monospace text. Best-effort only —
// punctuation, spaces, and non-Latin text pass through unchanged.
const UNI = {
  boldUp: 0x1D400, boldLow: 0x1D41A, boldDigit: 0x1D7CE,
  italUp: 0x1D434, italLow: 0x1D44E,
  boldItalUp: 0x1D468, boldItalLow: 0x1D482,
  monoUp: 0x1D670, monoLow: 0x1D68A, monoDigit: 0x1D7F6,
};
function styleChar(ch, style) {
  if (ch >= "A" && ch <= "Z") {
    const i = ch.charCodeAt(0) - 65;
    if (style === "bold") return String.fromCodePoint(UNI.boldUp + i);
    if (style === "italic") return String.fromCodePoint(UNI.italUp + i);
    if (style === "bolditalic") return String.fromCodePoint(UNI.boldItalUp + i);
    if (style === "mono") return String.fromCodePoint(UNI.monoUp + i);
  } else if (ch >= "a" && ch <= "z") {
    const i = ch.charCodeAt(0) - 97;
    if (style === "italic" && ch === "h") return "\u210E"; // Unicode gap: italic h has no math-alphanumeric slot
    if (style === "bold") return String.fromCodePoint(UNI.boldLow + i);
    if (style === "italic") return String.fromCodePoint(UNI.italLow + i);
    if (style === "bolditalic") return String.fromCodePoint(UNI.boldItalLow + i);
    if (style === "mono") return String.fromCodePoint(UNI.monoLow + i);
  } else if (ch >= "0" && ch <= "9") {
    const i = ch.charCodeAt(0) - 48;
    if (style === "bold") return String.fromCodePoint(UNI.boldDigit + i);
    if (style === "mono") return String.fromCodePoint(UNI.monoDigit + i);
  }
  return ch;
}
function toStyledUnicode(html) {
  const div = document.createElement("div");
  div.innerHTML = html || "";
  div.querySelectorAll("style, script").forEach((n) => n.remove());
  let out = "";
  function styleFor(stack) {
    const has = (t) => stack.includes(t);
    if (has("CODE") || has("PRE")) return "mono";
    const bold = has("B") || has("STRONG");
    const italic = has("I") || has("EM");
    if (bold && italic) return "bolditalic";
    if (bold) return "bold";
    if (italic) return "italic";
    return null;
  }
  function walk(node, stack, underline, strike) {
    if (node.nodeType === Node.TEXT_NODE) {
      const style = styleFor(stack);
      for (const ch of node.textContent) {
        out += style ? styleChar(ch, style) : ch;
        if (underline) out += "\u0332";
        if (strike) out += "\u0336";
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName;
    if (tag === "BR") { out += "\n"; return; }
    if (tag === "IMG") { out += "[image]"; return; }
    const nextUnderline = underline || tag === "U";
    const nextStrike = strike || tag === "S" || tag === "STRIKE" || tag === "DEL";
    const nextStack = stack.concat(tag);
    Array.from(node.childNodes).forEach((c) => walk(c, nextStack, nextUnderline, nextStrike));
    if (tag === "P" || tag === "DIV" || tag === "LI") out += "\n";
  }
  Array.from(div.childNodes).forEach((c) => walk(c, [], false, false));
  return out.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
}

// ---------- Real HTML for follow-up chat messages ----------
// sendMessage (unlike sendPoll) genuinely supports Telegram's HTML subset,
// so follow-up "answer reveal" messages keep real bold/italic/code/links.
const TG_TAG_MAP = { B: "b", STRONG: "b", I: "i", EM: "i", U: "u", S: "s", STRIKE: "s", DEL: "s", CODE: "code", PRE: "pre" };
function escapeTgHtml(s) {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function richTextToTelegramHtml(html) {
  const div = document.createElement("div");
  div.innerHTML = html || "";
  div.querySelectorAll("style, script").forEach((n) => n.remove());
  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) return escapeTgHtml(node.textContent);
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const tag = node.tagName;
    if (tag === "BR") return "\n";
    if (tag === "IMG") return "[image]";
    const inner = Array.from(node.childNodes).map(walk).join("");
    if (tag === "A") {
      const href = node.getAttribute("href") || "";
      return href ? `<a href="${escapeTgHtml(href)}">${inner}</a>` : inner;
    }
    const mapped = TG_TAG_MAP[tag];
    if (mapped) return `<${mapped}>${inner}</${mapped}>`;
    if (tag === "P" || tag === "DIV" || tag === "LI") return inner + "\n";
    return inner;
  }
  return Array.from(div.childNodes).map(walk).join("").replace(/\n{3,}/g, "\n\n").trim();
}
// Caps a follow-up message to Telegram's length limit. If it's too long,
// falls back to a plain-text (tag-free) truncation rather than risk cutting
// an HTML tag in half, which would make Telegram reject the whole message.
function tgCapMessage(html) {
  if (html.length <= TG_LIMITS.message) return html;
  return escapeTgHtml(tgTruncate(htmlToPlainText(html), TG_LIMITS.message));
}

// ---------- Payload building ----------
// Returns { ok:true, number, poll, followupHtml } or { ok:false, number, reason }.
function buildPayload(q, idx, mode) {
  const number = q.number || idx + 1;
  if (!q.options || q.options.length < 2) {
    return { ok: false, number, reason: "fewer than 2 options" };
  }
  if (q.options.length > TG_LIMITS.maxOptions) {
    return { ok: false, number, reason: `more than ${TG_LIMITS.maxOptions} options (Telegram's limit)` };
  }

  const questionText = tgTruncate(`Q${number}. ${toStyledUnicode(q.questionHtml)}`, TG_LIMITS.question);
  if (!questionText.replace(/^Q\d+\.\s*/, "").trim()) {
    return { ok: false, number, reason: "question text is empty after stripping formatting" };
  }
  const options = q.options.map((o) => tgTruncate(toStyledUnicode(o.html), TG_LIMITS.option) || "(blank)");
  const hasCorrect = q.correctIdx != null && q.correctIdx >= 0 && q.correctIdx < q.options.length;

  if (mode === "quiz") {
    if (!hasCorrect) return { ok: false, number, reason: "no correct answer was detected (required for quiz mode)" };
    const explanation = q.solutionHtml ? tgTruncate(toStyledUnicode(q.solutionHtml), TG_LIMITS.explanation) : "";
    return {
      ok: true, number,
      poll: { question: questionText, options, type: "quiz", is_anonymous: true,
               correct_option_id: q.correctIdx, explanation: explanation || undefined },
      followupHtml: null,
    };
  }

  // practice mode — regular poll (revotable) + spoiler-tagged rich-text answer
  let followupHtml = null;
  if (hasCorrect) {
    const letter = String.fromCharCode(65 + q.correctIdx);
    let html = `<b>Q${number} answer</b>\n<tg-spoiler>${escapeTgHtml(letter + ") ")}${richTextToTelegramHtml(q.options[q.correctIdx].html)}`;
    if (q.solutionHtml) html += `\n\n<b>Why:</b>\n${richTextToTelegramHtml(q.solutionHtml)}`;
    html += `</tg-spoiler>`;
    followupHtml = tgCapMessage(html);
  }
  return {
    ok: true, number,
    poll: { question: questionText, options, type: "regular", is_anonymous: true },
    followupHtml,
  };
}

// ---------- Bot API calls ----------
function resolveChatId(id) { return /^-?\d+$/.test(id) ? Number(id) : id; }
async function tgApiCall(settings, method, body) {
  const url = `https://api.telegram.org/bot${settings.botToken}/${method}`;
  let resp, data;
  try {
    resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    data = await resp.json().catch(() => ({}));
  } catch (e) {
    return { ok: false, error: "Network error \u2014 " + e.message };
  }
  if (data && data.ok) return { ok: true, result: data.result };
  if (data && data.error_code === 429 && data.parameters && data.parameters.retry_after) {
    return { ok: false, retryAfter: data.parameters.retry_after };
  }
  return { ok: false, error: (data && data.description) || ("HTTP " + (resp ? resp.status : "?")) };
}
async function sendPollAndFollowup(settings, item) {
  const pollBody = { chat_id: resolveChatId(settings.chatId), question: item.poll.question,
                      options: item.poll.options, type: item.poll.type, is_anonymous: item.poll.is_anonymous };
  if (item.poll.type === "quiz") {
    pollBody.correct_option_id = item.poll.correct_option_id;
    if (item.poll.explanation) pollBody.explanation = item.poll.explanation;
  }
  const pollRes = await tgApiCall(settings, "sendPoll", pollBody);
  if (!pollRes.ok) return pollRes;
  if (item.followupHtml) {
    await sleep(500);
    const msgId = pollRes.result && pollRes.result.message_id;
    const msgRes = await tgApiCall(settings, "sendMessage", {
      chat_id: resolveChatId(settings.chatId), text: item.followupHtml, parse_mode: "HTML",
      disable_web_page_preview: true, reply_to_message_id: msgId || undefined,
    });
    if (!msgRes.ok) return { ok: true, warning: "poll sent, but the answer-reveal message failed: " + (msgRes.error || msgRes.retryAfter ? "rate limited" : "") };
  }
  return { ok: true };
}

// ---------- Settings dialog ----------
function renderTelegramSettingsForm(existing, onSaved) {
  const tokenInput = el("input", { class: "tg-input", type: "password",
    placeholder: "123456789:AA...  (from @BotFather)", value: existing.botToken || "" });
  const chatInput = el("input", { class: "tg-input", type: "text",
    placeholder: "-1001234567890  or  @yourgroupusername", value: existing.chatId || "" });
  const err = el("div", { class: "tg-err" });

  const saveBtn = el("button", { class: "btn-save", onclick: async () => {
    const botToken = tokenInput.value.trim();
    const chatId = chatInput.value.trim();
    if (!botToken || !chatId) { err.textContent = "Both fields are required."; return; }
    await setTelegramSettings({ botToken, chatId });
    onSaved({ botToken, chatId });
  } }, "Save & continue");
  const cancelBtn = el("button", { onclick: closeTgOverlays }, "Cancel");

  return el("div", {},
    el("h2", {}, "Connect a Telegram group"),
    el("ol", { class: "tg-steps" },
      el("li", {}, "In Telegram, open a chat with @BotFather, send /newbot, and copy the token it gives you."),
      el("li", {}, "Add that bot to your group as a member (Group info \u2192 Add members)."),
      el("li", {}, "Get the group's chat ID: forward any message from the group to @userinfobot or @getidsbot \u2014 group IDs usually look like -1001234567890."),
    ),
    el("label", { class: "tg-label" }, "Bot token"), tokenInput,
    el("label", { class: "tg-label" }, "Group chat ID"), chatInput,
    err,
    el("div", { class: "tg-note" }, "Stored only on this device (chrome.storage.local), never uploaded anywhere except directly to Telegram when you send."),
    el("div", { class: "tg-actions" }, cancelBtn, saveBtn),
  );
}

// ---------- Send dialog ----------
async function startTelegramSend() {
  const settings = await getTelegramSettings();
  if (!settings.botToken || !settings.chatId) {
    tgOpen(renderTelegramSettingsForm(settings, () => { closeTgOverlays(); startTelegramSend(); }));
    return;
  }

  const builtByMode = {
    quiz: STATE.qs.map((q, i) => buildPayload(q, i, "quiz")),
    practice: STATE.qs.map((q, i) => buildPayload(q, i, "practice")),
  };

  const summary = el("div", { class: "tg-summary" });
  const sendBtn = el("button", { class: "btn-save" }, "Send");
  let currentMode = "quiz";

  function refreshSummary() {
    const built = builtByMode[currentMode];
    const sendable = built.filter((b) => b.ok);
    const skipped = built.filter((b) => !b.ok);
    summary.innerHTML = "";
    summary.appendChild(el("p", {}, currentMode === "quiz"
      ? `Sends ${sendable.length} native quiz poll(s) with instant right/wrong feedback and options styled with Unicode bold/italic where possible (plain text is a hard Telegram limit for polls). Telegram permanently locks each person's answer after their first vote \u2014 no reattempts, and this can't be changed from our side.`
      : `Sends ${sendable.length} regular poll(s) that anyone can revote on at any time (that's how reattempts become possible). The correct answer + explanation follow as a separate message with real bold/italic/code/links, hidden behind a tap-to-reveal spoiler so it doesn't give the answer away immediately.`
    ));
    if (skipped.length) {
      summary.appendChild(el("p", { class: "tg-warn" }, `${skipped.length} question(s) will be skipped:`));
      summary.appendChild(el("ul", { class: "tg-skip-list" }, ...skipped.map((s) => el("li", {}, `Q${s.number}: ${s.reason}`))));
    }
    sendBtn.textContent = sendable.length ? `Send ${sendable.length}` : "Nothing to send";
    sendBtn.disabled = sendable.length === 0;
    sendBtn.onclick = () => { closeTgOverlays(); runTelegramSend(sendable, settings); };
  }

  const quizRadio = el("input", { type: "radio", name: "tgMode", value: "quiz", checked: "checked" });
  const practiceRadio = el("input", { type: "radio", name: "tgMode", value: "practice" });
  quizRadio.addEventListener("change", () => { currentMode = "quiz"; refreshSummary(); });
  practiceRadio.addEventListener("change", () => { currentMode = "practice"; refreshSummary(); });

  const modeBox = el("div", { class: "tg-mode-box" },
    el("label", { class: "tg-mode-opt" }, quizRadio, el("span", {}, el("strong", {}, "Quiz"), " \u2014 auto-graded, one attempt per person")),
    el("label", { class: "tg-mode-opt" }, practiceRadio, el("span", {}, el("strong", {}, "Practice"), " \u2014 unlimited re-votes, answer hidden behind a spoiler")),
  );

  refreshSummary();
  tgOpen(el("div", {},
    el("h2", {}, "Send to Telegram"),
    modeBox,
    summary,
    el("div", { class: "tg-note" }, "Sending to: ", el("code", {}, settings.chatId), " \u2014 ",
      el("a", { href: "#", onclick: (e) => { e.preventDefault(); tgOpen(renderTelegramSettingsForm(settings, (s) => { closeTgOverlays(); startTelegramSend(); })); } }, "change")),
    el("div", { class: "tg-actions" },
      el("button", { onclick: closeTgOverlays }, "Cancel"),
      sendBtn,
    ),
  ));
}

async function runTelegramSend(items, settings) {
  const fill = el("div", { class: "tg-progress-fill" });
  const line = el("div", { class: "tg-progress-line" }, `0 / ${items.length}`);
  const log = el("div", { class: "tg-log" });
  const closeBtn = el("button", { class: "btn-save", onclick: closeTgOverlays }, "Close");
  closeBtn.style.display = "none";
  const box = el("div", {},
    el("h2", {}, "Sending to Telegram\u2026"),
    el("div", { class: "tg-progress-track" }, fill),
    line, log,
    el("div", { class: "tg-actions" }, closeBtn),
  );
  tgOpen(box);

  let ok = 0, fail = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    line.textContent = `${i + 1} / ${items.length} \u2014 Question ${item.number}`;
    const res = await sendPollAndFollowup(settings, item);
    if (res.ok) {
      ok++;
      if (res.warning) log.appendChild(el("div", { class: "tg-log-warn" }, `Q${item.number}: ${res.warning}`));
    } else if (res.retryAfter) {
      log.appendChild(el("div", {}, `Rate limited by Telegram \u2014 waiting ${res.retryAfter}s\u2026`));
      await sleep(res.retryAfter * 1000 + 300);
      i--; // retry the same question
      continue;
    } else {
      fail++;
      log.appendChild(el("div", { class: "tg-log-err" }, `Q${item.number}: ${res.error || "failed"}`));
    }
    fill.style.width = Math.round(((i + 1) / items.length) * 100) + "%";
    await sleep(1200); // keep well under Telegram's per-chat rate limit
  }
  line.textContent = `Done \u2014 ${ok} sent${fail ? `, ${fail} failed` : ""}.`;
  closeBtn.style.display = "";
}


// ---------- Export to standalone HTML ----------
function saveExport() {
  const html = buildStandaloneHtml(STATE.title, STATE.qs);
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const safe = (STATE.title || "mock").replace(/[^\w\-]+/g, "_").slice(0, 80) || "mock";
  a.download = safe + ".html";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function fmtTimeStatic(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function buildStandaloneHtml(title, qs) {
  const blocks = qs.map((q) => {
    const opts = q.options.map((o, i) => {
      const letter = String.fromCharCode(97 + i);
      return `<li data-correct="${o.correct ? 1 : 0}">
        <span class="letter">${letter}.</span>
        <span class="opt-html">${o.html}</span>
      </li>`;
    }).join("");
    const correctLetter = q.correctIdx >= 0
      ? String.fromCharCode(65 + q.correctIdx) : "?";
    const sol = q.solutionHtml
      ? q.solutionHtml
      : "<em>(No solution was visible when this question was captured.)</em>";
    const videoHtml = (q.videoId && q.videoStart != null)
      ? `<div class="sol-video">
           <iframe src="https://www.youtube.com/embed/${q.videoId}?start=${q.videoStart}${q.videoEnd ? "&end=" + q.videoEnd : ""}&rel=0"
                   frameborder="0" allow="autoplay; encrypted-media" allowfullscreen></iframe>
           <div class="sol-video-caption">From ${escapeHtml(q.mockLabel || "video")}, timestamp ${fmtTimeStatic(q.videoStart)}</div>
         </div>`
      : "";
    const t = q.timing || {};
    const chips = [
      t.you ? `<span class="chip">Your time: ${escapeHtml(t.you)}</span>` : "",
      t.avg ? `<span class="chip chip-avg">Avg: ${escapeHtml(t.avg)}</span>` : "",
    ].join("");
    return `<section class="q" data-num="${q.number}">
  <div class="qhead">
    <div class="qnum">Question ${q.number}</div>
    <div class="qmeta">${chips}</div>
  </div>
  <div class="qbody">${q.questionHtml}</div>
  <ol class="opts">${opts}</ol>
  <div class="btns">
    <button class="btn-ans">Show Answer</button>
    <button class="btn-sol">Show Solution</button><button class="btn-mark">\u2b50 Save</button>
  </div>
  <div class="ans hidden"><strong>Answer:</strong> ${correctLetter}</div>
  <div class="sol hidden"><strong>Solution</strong>${videoHtml}<div class="sol-body">${sol}</div></div>
</section>`;
  }).join("\n");

  const css = `
:root { --primary:#2563eb; --green:#16a34a; --bg:#fff; --fg:#111; --muted:#6b7280; }
* { box-sizing: border-box; }
body { margin:0; font:16px/1.6 -apple-system, system-ui, "Segoe UI", Roboto, sans-serif;
       color:var(--fg); background:var(--bg); }
header { position:sticky; top:0; z-index:10; background:#fff; border-bottom:1px solid #e5e7eb;
         display:flex; align-items:center; gap:10px; padding:12px 24px; }
header h1 { font-size:20px; margin:0; flex:1; }
header .meta { color:var(--muted); font-size:12px; padding:0 8px; }
header button { padding:8px 16px; border:none; border-radius:5px; cursor:pointer; font-size:14px; font-weight:600; font-family:inherit; }
.btn-save  { background:var(--green); color:#fff; }
.btn-all-a { background:#eff6ff; color:var(--primary); border:1px solid #bfdbfe !important; }
.btn-all-s { background:#f0fdf4; color:var(--green); border:1px solid #bbf7d0 !important; }
main { max-width:880px; margin: 0 auto; padding: 20px 24px 80px; }
.q { padding:20px 0; border-bottom:1px dashed #e5e7eb; }
.q:last-child { border-bottom:none; }
.qhead { display:flex; align-items:center; gap:10px; margin-bottom:10px; flex-wrap:wrap; }
.qnum { font-weight:700; color:var(--primary); font-size:15px; }
.qmeta { display:flex; gap:6px; flex-wrap:wrap; }
.chip { display:inline-block; padding:2px 9px; border-radius:10px; font-size:12px;
        background:#eff6ff; color:var(--primary); border:1px solid #bfdbfe; font-weight:500; }
.chip-avg { background:#f3f4f6; color:#4b5563; border-color:#e5e7eb; }
.qbody { margin: 0 0 14px; }
.qbody img, .sol img { max-width:100%; height:auto; }
ol.opts { list-style:none; padding:0; margin: 0 0 14px; }
ol.opts li { padding:8px 12px; margin:6px 0; border:1px solid #e5e7eb; border-radius:6px;
             display:flex; gap:10px; align-items:flex-start; background:#fff; }
ol.opts li .letter { font-weight:700; color:#555; min-width:18px; }
ol.opts li .opt-html p { margin:0; }
.q.reveal-ans ol.opts li[data-correct="1"] { background:#dcfce7; border-color:#86efac; }
.q.reveal-ans ol.opts li[data-correct="1"] .letter { color: var(--green); }
.btns { display:flex; gap:8px; margin: 6px 0 4px; flex-wrap:wrap; }
.btns button { padding:6px 12px; border:1px solid #d1d5db; background:#f9fafb;
               border-radius:5px; cursor:pointer; font-size:13px; font-weight:500; font-family:inherit; }
.btns button:hover { background:#f3f4f6; }
.hidden { display:none !important; }
.ans { padding:10px 14px; background:#dbeafe; border-left:3px solid var(--primary); margin: 8px 0; border-radius:4px; }
.sol { padding:12px 14px; background:#f9fafb; border-left:3px solid var(--green); margin: 8px 0; border-radius:4px; }
.sol > strong { display:block; color:var(--green); margin-bottom:6px; }
.sol-body p { margin: 0 0 6px; }
.sol-body ul, .sol-body ol { margin: 6px 0 6px 22px; padding:0; }
.sol-video { margin: 4px 0 12px; }
.sol-video iframe { width:100%; aspect-ratio:16/9; border-radius:6px; display:block; }
.sol-video-caption { font-size:11px; color:var(--muted); margin-top:4px; }
.q .qbody .bg-red-100, .q .qbody .bg-green-100,
ol.opts li .bg-red-100, ol.opts li .bg-green-100 { background: transparent !important; }
@media print {
  header { position: static; }
  .btns, .btn-save, .btn-all-a, .btn-all-s { display:none !important; }
  .hidden { display:block !important; }
  .q { page-break-inside: avoid; }
}`;

  // Inline script for the exported file — runs on its own.
  // Owns ONLY the per-question btn-ans / btn-sol toggles. The "All Answers" /
  // "All Solutions" header toggles are owned exclusively by saveJs to avoid
  // conflicting click handlers on the same button.
  const inlineJs = `
(function(){
  function ts(n){ if(window.MathJax && MathJax.typesetPromise) MathJax.typesetPromise(n?[n]:undefined).catch(function(){}); }
  document.querySelectorAll('.btn-ans').forEach(function(btn){
    btn.addEventListener('click', function(){
      var q=btn.closest('.q'); var ans=q.querySelector('.ans');
      q.classList.toggle('reveal-ans');
      var showing=!ans.classList.contains('hidden');
      if(showing){ ans.classList.add('hidden'); btn.textContent='Show Answer'; }
      else { ans.classList.remove('hidden'); btn.textContent='Hide Answer'; }
    });
  });
  document.querySelectorAll('.btn-sol').forEach(function(btn){
    btn.addEventListener('click', function(){
      var q=btn.closest('.q'); var sol=q.querySelector('.sol');
      var showing=!sol.classList.contains('hidden');
      if(showing){ sol.classList.add('hidden'); btn.textContent='Show Solution'; }
      else { sol.classList.remove('hidden'); btn.textContent='Hide Solution'; ts(sol); }
    });
  });
  ts();
})();`;

  // Beige/Georgia theme overlay (matches reference look)
  const themeCss = `
body{font-family:Georgia,"Times New Roman",serif!important;background:#ece6d8!important;color:#222!important;}
header{background:#f7f2e8!important;border-bottom:2px solid #b08d57!important;}
main{max-width:950px!important;background:#fffdf8;margin:20px auto!important;padding:35px!important;box-shadow:0 0 18px rgba(0,0,0,.12);}
.q{background:#fffefb;padding:25px!important;margin-bottom:25px!important;border:1px solid #d8c9a7!important;border-radius:10px;}
.qnum{font-size:22px!important;color:#6b4f2a!important;}
.qbody{font-size:18px!important;}
ol.opts li{background:#faf7ef!important;border:1px solid #d8c9a7!important;}
.btns button,header button{border-radius:8px!important;}`;

  // Save / saved-question styling + sort select
  const markCss = `
.btn-mark{background:#fef3c7;border:1px solid #f59e0b!important}
.q.saved-question{
 background:#dcfce7!important;
 border:2px solid #22c55e!important;
 box-shadow:0 0 12px rgba(34,197,94,.25);
}
.sort-select{padding:8px 12px;border:1px solid #d1d5db;border-radius:5px;
 background:#fff;color:#111;font-size:14px;font-weight:600;cursor:pointer;
 font-family:inherit;}
.sort-select:focus{outline:2px solid #2563eb;outline-offset:1px;}`;

  // Responsive header overlay
  const respCss = `
header{flex-wrap:wrap!important;padding:12px!important}
header h1{flex:1 1 100%}
header button{min-width:140px;max-width:100%;flex:1 1 auto}
@media(max-width:768px){
  main{padding:14px!important}
  header button{font-size:12px;padding:10px 8px}
  .q{padding:16px!important}
}`;

  // Save-HTML + toggle All Answers / All Solutions script.
  // This is the SOLE owner of #showAllA / #showAllS click handlers; it also
  // updates each per-question btn-ans / btn-sol label so individual buttons
  // stay in sync with the bulk-toggle state.
  const saveJs = `
document.addEventListener('DOMContentLoaded',function(){

function ts(n){ if(window.MathJax && MathJax.typesetPromise) MathJax.typesetPromise(n?[n]:undefined).catch(function(){}); }

const save=document.getElementById('saveHtmlBtn');
if(save){
 save.addEventListener('click',function(){
   const blob=new Blob([document.documentElement.outerHTML],{type:'text/html'});
   const a=document.createElement('a');
   a.href=URL.createObjectURL(blob);
   a.download='Online_Test.html';
   a.click();
 });
}

const ans=document.getElementById('showAllA');
if(ans){
 let visible=false;
 ans.addEventListener('click',function(){
   visible=!visible;
   document.querySelectorAll('.q').forEach(function(q){
     const a=q.querySelector('.ans'); if(a) a.classList.toggle('hidden',!visible);
     q.classList.toggle('reveal-ans',visible);
     const b=q.querySelector('.btn-ans'); if(b) b.textContent=visible?'Hide Answer':'Show Answer';
   });
   ans.textContent=visible?'Hide Answers':'All Answers';
 });
}

const sol=document.getElementById('showAllS');
if(sol){
 let visible=false;
 sol.addEventListener('click',function(){
   visible=!visible;
   document.querySelectorAll('.q').forEach(function(q){
     const s=q.querySelector('.sol'); if(s) s.classList.toggle('hidden',!visible);
     const b=q.querySelector('.btn-sol'); if(b) b.textContent=visible?'Hide Solution':'Show Solution';
   });
   sol.textContent=visible?'Hide Solutions':'All Solutions';
   if(visible) ts();
 });
}

});`;

  // Sort-by-time script. Parses "MM:SS", "H:MM:SS", "Ns", "Nm Xs", "Nm".
  const sortJs = `
document.addEventListener('DOMContentLoaded',function(){
  const sel=document.getElementById('sortByTime');
  if(!sel) return;
  const main=document.querySelector('main');
  if(!main) return;
  const original=Array.from(main.querySelectorAll('.q'));
  function parseTime(s){
    if(!s) return null;
    s=String(s).trim();
    let m=s.match(/(\\d+):(\\d+):(\\d+)/);
    if(m) return (+m[1])*3600+(+m[2])*60+(+m[3]);
    m=s.match(/(\\d+):(\\d+)/);
    if(m) return (+m[1])*60+(+m[2]);
    let sec=0,had=false;
    m=s.match(/(\\d+)\\s*m/i); if(m){sec+=(+m[1])*60;had=true;}
    m=s.match(/(\\d+)\\s*s/i); if(m){sec+=(+m[1]);had=true;}
    if(had) return sec;
    m=s.match(/(\\d+)/);
    return m?(+m[1]):null;
  }
  function getYourTime(q){
    const chip=q.querySelector('.chip');
    if(!chip) return null;
    const t=chip.textContent.replace(/your\\s*time\\s*:?/i,'').trim();
    return parseTime(t);
  }
  sel.addEventListener('change',function(){
    const mode=sel.value;
    let arr=original.slice();
    if(mode==='asc'||mode==='desc'){
      arr.sort(function(a,b){
        const ta=getYourTime(a),tb=getYourTime(b);
        if(ta==null&&tb==null) return 0;
        if(ta==null) return 1;
        if(tb==null) return -1;
        return mode==='asc'?ta-tb:tb-ta;
      });
    }
    arr.forEach(function(q){main.appendChild(q);});
  });
});`;

  // localStorage-backed per-question Save (star) script.
  // localStorage may throw in sandboxed iframes / opaque-origin contexts —
  // wrap every access so the click handler still attaches and the toggle
  // works (just without persistence) instead of silently dying.
  const markJs = `
document.addEventListener('DOMContentLoaded',()=>{
 function lsGet(k){try{return localStorage.getItem(k);}catch(e){return null;}}
 function lsSet(k,v){try{localStorage.setItem(k,v);}catch(e){}}
 function lsDel(k){try{localStorage.removeItem(k);}catch(e){}}
 document.querySelectorAll('.q').forEach((q,index)=>{
   const btn=q.querySelector('.btn-mark');
   if(!btn) return;
   const key='saved_q_'+(index+1);

   if(lsGet(key)==='1'){
      q.classList.add('saved-question');
      btn.textContent='\u2605 Saved';
   }

   btn.addEventListener('click',(e)=>{
      e.preventDefault();
      e.stopPropagation();
      const saved=q.classList.toggle('saved-question');
      if(saved){
        lsSet(key,'1');
        btn.textContent='\u2605 Saved';
      }else{
        lsDel(key);
        btn.textContent='\u2b50 Save';
      }
   });
 });
});`;

  // Build the document. Use array join (no nested template literals to avoid
  // any </script> termination issues).
  return [
    '<!DOCTYPE html>',
    '<html lang="en"><head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>' + escapeHtml(title) + '</title>',
    '<scr' + 'ipt>window.MathJax={tex:{inlineMath:[["$","$"],["\\\\(","\\\\)"]],displayMath:[["$$","$$"],["\\\\[","\\\\]"]]},svg:{fontCache:"global"}};</scr' + 'ipt>',
    '<scr' + 'ipt src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js" async></scr' + 'ipt>',
    '<style>' + css + '</style>',
    '<style>' + themeCss + '</style>',
    '<style>' + markCss + '</style>',
    '</head><body>',
    '<header>',
    '  <h1>' + escapeHtml(title) + '</h1>',
    '  <div class="meta">' + qs.length + ' questions</div>',
    '  <button class="btn-all-a" id="showAllA">All Answers</button>',
    '  <button class="btn-all-s" id="showAllS">All Solutions</button>',
    '  <select class="sort-select" id="sortByTime" title="Sort questions by your time">' +
      '<option value="default">Sort: Default</option>' +
      '<option value="asc">Your time \u2191 (low\u2192high)</option>' +
      '<option value="desc">Your time \u2193 (high\u2192low)</option>' +
    '</select>',
    '  <button class="btn-save" id="saveHtmlBtn">Save HTML</button>',
    '</header>',
    '<main>',
    blocks,
    '</main>',
    '<scr' + 'ipt>' + inlineJs + '</scr' + 'ipt>',
    '<style>' + respCss + '</style>',
    '<scr' + 'ipt>' + saveJs + '</scr' + 'ipt>',
    '<scr' + 'ipt>' + sortJs + '</scr' + 'ipt>',
    '<scr' + 'ipt>' + markJs + '</scr' + 'ipt>',
    '</body></html>'
  ].join('\n');
}
