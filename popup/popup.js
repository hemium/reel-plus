/*
 * Reels+ — Popup logic
 * Two independent features: progress bar + auto-scroll (when built in).
 */
(() => {
  'use strict';

  const FEATURES = window.REELS_PLUS_FEATURES || { AUTO_SCROLL: true };
  const AUTO_SCROLL_UI = !!FEATURES.AUTO_SCROLL;

  const STORAGE_KEYS = {
    AUTO_SCROLL: 'autoScroll',
    PROGRESS_BAR: 'progressBar',
    REPEAT_COUNT: 'repeatCount',
    LEGACY_ENABLED: 'enabled',
  };

  const DEFAULTS = {
    autoScroll: false,
    progressBar: true,
    repeatCount: 1,
  };

  const $autoScrollFeature = document.getElementById('autoScrollFeature');
  const $autoScroll = document.getElementById('autoScrollToggle');
  const $progress = document.getElementById('progressToggle');
  const $autoDot = document.getElementById('autoScrollDot');
  const $progressDot = document.getElementById('progressDot');
  const $repeat = document.getElementById('repeatInput');
  const $repeatRow = document.getElementById('repeatRow');
  const $inc = document.getElementById('inc');
  const $dec = document.getElementById('dec');
  const $status = document.getElementById('status');

  if (!AUTO_SCROLL_UI && $autoScrollFeature) {
    $autoScrollFeature.hidden = true;
  }

  function applyItems(items) {
    const autoScroll = AUTO_SCROLL_UI && (
      items.autoScroll !== undefined
        ? !!items.autoScroll
        : !!items.enabled
    );
    const progressBar = items.progressBar !== undefined
      ? !!items.progressBar
      : DEFAULTS.progressBar;

    if (AUTO_SCROLL_UI) {
      $autoScroll.checked = autoScroll;
      $repeat.value = clampRepeat(items.repeatCount);
      reflectRepeatEnabled(autoScroll);
    }
    $progress.checked = progressBar;
    reflectDots(autoScroll, progressBar);
  }

  chrome.storage.sync.get(
    { ...DEFAULTS, [STORAGE_KEYS.LEGACY_ENABLED]: undefined },
    applyItems
  );

  if (AUTO_SCROLL_UI) {
    $autoScroll.addEventListener('change', () => {
      const autoScroll = $autoScroll.checked;
      chrome.storage.sync.set({ [STORAGE_KEYS.AUTO_SCROLL]: autoScroll }, () => {
        reflectDots(autoScroll, $progress.checked);
        reflectRepeatEnabled(autoScroll);
        pingActiveTab();
      });
    });
  }

  $progress.addEventListener('change', () => {
    const progressBar = $progress.checked;
    chrome.storage.sync.set({ [STORAGE_KEYS.PROGRESS_BAR]: progressBar }, () => {
      const autoScroll = AUTO_SCROLL_UI && $autoScroll.checked;
      reflectDots(autoScroll, progressBar);
      pingActiveTab();
    });
  });

  function commitRepeat() {
    if (!AUTO_SCROLL_UI) return;
    const v = clampRepeat(parseInt($repeat.value, 10));
    $repeat.value = v;
    chrome.storage.sync.set({ [STORAGE_KEYS.REPEAT_COUNT]: v });
  }

  if (AUTO_SCROLL_UI) {
    $repeat.addEventListener('change', commitRepeat);
    $repeat.addEventListener('blur', commitRepeat);
    $repeat.addEventListener('input', () => {
      const v = clampRepeat(parseInt($repeat.value, 10));
      if (String(v) !== $repeat.value) $repeat.value = v;
    });

    $inc.addEventListener('click', () => {
      $repeat.value = clampRepeat(parseInt($repeat.value, 10) + 1);
      commitRepeat();
    });
    $dec.addEventListener('click', () => {
      $repeat.value = clampRepeat(parseInt($repeat.value, 10) - 1);
      commitRepeat();
    });
  }

  function clampRepeat(v) {
    if (!Number.isFinite(v)) v = DEFAULTS.repeatCount;
    return Math.max(1, Math.min(20, Math.floor(v)));
  }

  function reflectDots(autoScroll, progressBar) {
    if (AUTO_SCROLL_UI) $autoDot.classList.toggle('on', autoScroll);
    $progressDot.classList.toggle('on', progressBar);
  }

  function reflectRepeatEnabled(autoScroll) {
    if (!AUTO_SCROLL_UI) return;
    $repeatRow.classList.toggle('disabled', !autoScroll);
    $repeat.disabled = !autoScroll;
    $inc.disabled = !autoScroll;
    $dec.disabled = !autoScroll;
  }

  function pingActiveTab() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab) return updateStatusUnknown();
      chrome.tabs.sendMessage(tab.id, { type: 'IG_REELS_REQUEST_STATUS' }, () => {
        if (chrome.runtime.lastError) updateStatusUnknown();
      });
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'IG_REELS_STATUS') {
      updateStatus(msg.payload || {});
    }
  });

  function updateStatus(p) {
    const onReels = !!p.onReelsPage;
    const active = !!p.active;
    const autoScroll = AUTO_SCROLL_UI && !!p.autoScroll;
    const progressBar = !!p.progressBar;
    const anyOn = autoScroll || progressBar;

    if (!anyOn) {
      $status.textContent = AUTO_SCROLL_UI ? 'All features off.' : 'Progress bar off.';
      $status.classList.add('off');
      return;
    }
    if (!onReels) {
      $status.textContent = 'Not on a Reels page.';
      $status.classList.add('off');
      return;
    }

    const bits = [];
    if (progressBar) bits.push('progress');
    if (autoScroll) {
      const pc = Number.isFinite(p.playCount) ? p.playCount : 0;
      const rc = Number.isFinite(p.repeatCount) ? p.repeatCount : 1;
      bits.push(`auto ${pc}/${rc}`);
    }
    $status.textContent = active
      ? `On Reels · ${bits.join(' · ')}`
      : 'On this page.';
    $status.classList.remove('off');
  }

  function updateStatusUnknown() {
    $status.textContent = 'Open instagram.com/reels to activate.';
    $status.classList.add('off');
  }

  pingActiveTab();
})();
