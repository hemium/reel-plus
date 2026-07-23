/*
 * Reels+ — Background Service Worker (MV3)
 * Seeds defaults (with migration from v1 `enabled` key) and relays status.
 */

const DEFAULTS = {
  autoScroll: false,
  progressBar: true,
  repeatCount: 1,
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(null, (items) => {
    const patch = {};

    // Migrate legacy `enabled` → `autoScroll`
    if (items.autoScroll === undefined) {
      patch.autoScroll = items.enabled !== undefined ? !!items.enabled : DEFAULTS.autoScroll;
    }
    if (items.progressBar === undefined) patch.progressBar = DEFAULTS.progressBar;
    if (items.repeatCount === undefined) patch.repeatCount = DEFAULTS.repeatCount;

    if (Object.keys(patch).length) chrome.storage.sync.set(patch);
  });
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: 'https://www.instagram.com/reels/' });
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'IG_REELS_STATUS') {
    try {
      chrome.runtime.sendMessage({
        type: 'IG_REELS_STATUS',
        payload: msg.payload,
        from: sender.tab ? sender.tab.id : null,
      }).catch(() => {});
    } catch (_e) {}
  }
  return true;
});
