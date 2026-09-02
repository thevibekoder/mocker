// Background service worker — opens the preview tab on request, and keeps
// the timestamp map fresh in the background via a periodic alarm.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "openPreview" && msg.key) {
    const url = chrome.runtime.getURL("preview.html") + "?key=" + encodeURIComponent(msg.key);
    chrome.tabs.create({ url });
    sendResponse({ ok: true });
    return true;
  }
});

const MAP_URL_KEY   = "mockExtractor::videoMapUrl";
const MAP_CACHE_KEY = "mockExtractor::videoMapCache";
const MAP_TIME_KEY  = "mockExtractor::videoMapSyncedAt";
const ALARM_NAME    = "mockExtractor::syncMap";

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 60 }); // check hourly
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 60 });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  const data = await chrome.storage.local.get(MAP_URL_KEY);
  const url = data[MAP_URL_KEY];
  if (!url) return;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return;
    const fresh = await res.json();
    await chrome.storage.local.set({
      [MAP_CACHE_KEY]: fresh,
      [MAP_TIME_KEY]: Date.now(),
    });
  } catch (e) {
    // Offline or URL unreachable this cycle - next alarm will retry.
  }
});
