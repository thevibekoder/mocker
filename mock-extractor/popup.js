// Popup: thin wrapper over the same actions the floating panel exposes.

const $ = (id) => document.getElementById(id);
function setErr(msg) { $("err").textContent = msg || ""; }

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refresh() {
  setErr("");
  const tab = await getActiveTab();
  $("urlLine").textContent = tab.url || "—";
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: "getStatus" });
    if (res && res.ok) {
      $("count").textContent = res.count;
      window.__bucketKey = res.key;
    }
  } catch (e) {
    $("count").textContent = "—";
    setErr("Reload the mock tab and try again.");
  }
}

$("capture").addEventListener("click", async () => {
  try {
    const tab = await getActiveTab();
    await chrome.tabs.sendMessage(tab.id, { type: "capture" });
    setTimeout(refresh, 400);
  } catch (e) { setErr(e.message); }
});

$("clear").addEventListener("click", async () => {
  if (!window.__bucketKey) return;
  if (!confirm("Clear ALL saved questions (across every mock, not just this one)? This can't be undone.")) return;
  await chrome.storage.local.remove(window.__bucketKey);
  refresh();
});

$("preview").addEventListener("click", async () => {
  if (!window.__bucketKey) { setErr("Nothing captured yet."); return; }
  chrome.runtime.sendMessage({ type: "openPreview", key: window.__bucketKey });
  window.close();
});

const MAP_URL_KEY   = "mockExtractor::videoMapUrl";
const MAP_CACHE_KEY = "mockExtractor::videoMapCache";
const MAP_TIME_KEY  = "mockExtractor::videoMapSyncedAt";

function timeAgo(ms) {
  if (!ms) return "never";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  return `${Math.floor(h / 24)} day(s) ago`;
}

async function refreshMapStatus() {
  const data = await chrome.storage.local.get([MAP_URL_KEY, MAP_CACHE_KEY, MAP_TIME_KEY]);
  if (data[MAP_URL_KEY]) $("mapUrl").value = data[MAP_URL_KEY];
  const mockCount = data[MAP_CACHE_KEY] ? Object.keys(data[MAP_CACHE_KEY]).length : 0;
  $("mapStatus").textContent = data[MAP_URL_KEY]
    ? `${mockCount} mock(s) cached · last synced ${timeAgo(data[MAP_TIME_KEY])}`
    : "Not configured yet.";
}

$("saveMapUrl").addEventListener("click", async () => {
  const url = $("mapUrl").value.trim();
  if (!url) { setErr("Enter a URL first."); return; }
  await chrome.storage.local.set({ [MAP_URL_KEY]: url });
  setErr("");
  await doSync();
});

$("syncNow").addEventListener("click", doSync);

async function doSync() {
  const data = await chrome.storage.local.get(MAP_URL_KEY);
  const url = data[MAP_URL_KEY];
  if (!url) { setErr("Set a URL first."); return; }
  $("mapStatus").textContent = "Syncing…";
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const fresh = await res.json();
    await chrome.storage.local.set({
      [MAP_CACHE_KEY]: fresh,
      [MAP_TIME_KEY]: Date.now(),
    });
    setErr("");
  } catch (e) {
    setErr("Sync failed: " + e.message);
  }
  refreshMapStatus();
}

refresh();
refreshMapStatus();
