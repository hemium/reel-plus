/*
 * Reels+ — Content Script
 * ----------------------------------------------------------------------------
 * Quality-of-life upgrades for Instagram web Reels:
 *  - Progress bar (Stories-style segments, YouTube-style hover scrub)
 *  - Optional auto-advance after N full plays
 *
 * Design goals:
 *  - Features are independently toggleable.
 *  - Event-driven (video events + MutationObserver). No aggressive polling.
 *  - Resilient selectors with fallbacks (Instagram DOM changes often).
 *  - Natural advancement: real click on Next button > keyboard > scroll.
 *  - Fully removable when all features are off.
 *  - No external network requests, no data collection.
 * ----------------------------------------------------------------------------
 */
(() => {
  'use strict';

  if (window.__igReelsPlusInjected) return;
  window.__igReelsPlusInjected = true;
  // Legacy guard from v1 name — avoid double-binding if an old inject lingered.
  window.__igReelsAutoScrollInjected = true;

  const FEATURES = window.REELS_PLUS_FEATURES || { AUTO_SCROLL: true };

  // -------------------------------------------------------------------------
  // Constants & resilient selector lists
  // -------------------------------------------------------------------------

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

  // Reels URL detection. Instagram serves Reels from /reel/<id>/ and /reels/ tab.
  const REELS_URL_PATTERNS = [
    /instagram\.com\/reel\//i,
    /instagram\.com\/reels\/?($|\?|#)/i,
    /instagram\.com\/reels\//i,
  ];

  // Resilient selector candidates. Order matters: try the most specific first.
  const VIDEO_SELECTORS = [
    'video[x-playback-mode]',
    'video[playsinline]',
    'main video',
    'section main video',
    'div[role="presentation"] video',
    'article video',
    'video',
  ];

  const NEXT_BUTTON_SELECTORS = [
    'button[aria-label="Next"]',
    'button[aria-label="Go to next video"]',
    'div[role="button"][aria-label="Next"]',
    'button svg[aria-label="Next"]',
    'div[role="button"][aria-label*="Next" i]',
  ];

  const END_THRESHOLD_SECONDS = 0.3;
  const NAV_DEBOUNCE_MS = 450;
  const ADVANCE_COOLDOWN_MS = 1200;
  const VIDEO_SETTLE_MS = 350;
  const DOM_OBSERVE_DEBOUNCE_MS = 200;

  const PROGRESS_HOST_ID = 'ig-reels-plus-progress-host';
  const PROGRESS_Z = 2147483000;

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  const state = {
    autoScroll: DEFAULTS.autoScroll,
    progressBar: DEFAULTS.progressBar,
    repeatCount: DEFAULTS.repeatCount,

    isReelsPage: false,
    active: false,            // monitoring on (any feature on + reels page)

    activeVideo: null,
    playCount: 0,
    videoEndedFired: false,
    advancing: false,
    advancingTimer: null,

    listeners: new Map(),

    progressHost: null,
    progressRoot: null,
    progressSegCount: 0,
    progressRaf: 0,
    progressScrubbing: false,
    progressScrubCleanup: null,
  };

  let mutationObserver = null;
  let domObserverTimer = null;
  let navTimer = null;
  let progressLayoutBound = false;
  let progressLayoutRaf = 0;
  let progressSettleTimers = [];

  function anyFeatureOn() {
    return !!(state.autoScroll || state.progressBar);
  }

  function progressSegmentCount() {
    // Auto-scroll: one segment per planned play. Progress-only: a single bar.
    if (state.autoScroll) return Math.max(1, Math.min(20, state.repeatCount | 0));
    return 1;
  }

  function clearProgressSettleTimers() {
    for (const t of progressSettleTimers) clearTimeout(t);
    progressSettleTimers = [];
    if (progressLayoutRaf) {
      cancelAnimationFrame(progressLayoutRaf);
      progressLayoutRaf = 0;
    }
  }

  /** True when a video is still a reasonable on-screen Reel candidate. */
  function isVideoUsable(video) {
    if (!video || video.tagName !== 'VIDEO') return false;
    if (!video.isConnected) return false;
    try {
      const r = video.getBoundingClientRect();
      if (r.width < 80 || r.height < 80) return false;
      // Must intersect the viewport meaningfully (centered full-screen Reels are OK).
      return queryVisibleArea(video) > 80 * 80;
    } catch (_e) {
      return false;
    }
  }

  /** Stricter: center of the video is inside the viewport (outgoing slides fail this). */
  function isVideoPrimary(video) {
    if (!isVideoUsable(video)) return false;
    try {
      const r = video.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      return cx >= 0 && cx <= window.innerWidth && cy >= 0 && cy <= window.innerHeight;
    } catch (_e) {
      return false;
    }
  }

  function refreshActiveVideo(opts = {}) {
    const { resetCount = false } = opts;
    if (!state.active) return null;
    const next = findReelsVideo();
    if (next && next !== state.activeVideo) {
      bindVideo(next);
      if (resetCount) resetPlayCount();
    } else if (next && state.progressBar) {
      // Same node, but layout may have changed (resize / reel settle).
      updateProgressBar(next);
    }
    // Never hide solely because find() missed during a resize mid-frame —
    // keep the last binding and let settle retries re-anchor.
    return state.activeVideo;
  }

  function syncProgressLayout(opts = {}) {
    if (!state.active || !state.progressBar) return;
    const { settle = false } = opts;
    refreshActiveVideo({ resetCount: false });
    const video = state.activeVideo;
    if (video && video.isConnected) {
      const r = video.getBoundingClientRect();
      if (r.width >= 40 && r.height >= 40) {
        positionProgressBar(video);
        updateProgressBar(video);
      }
    }

    if (!settle) return;
    clearProgressSettleTimers();
    // Instagram reflows after maximize / next-reel; retry while layout settles.
    for (const ms of [50, 150, 350, 700, 1200]) {
      progressSettleTimers.push(setTimeout(() => {
        if (!state.active || !state.progressBar) return;
        refreshActiveVideo({ resetCount: false });
        const v = state.activeVideo;
        if (v && v.isConnected) {
          positionProgressBar(v);
          updateProgressBar(v);
        }
      }, ms));
    }
  }

  function onProgressLayout() {
    if (!state.active || !state.progressBar) return;
    if (progressLayoutRaf) return;
    progressLayoutRaf = requestAnimationFrame(() => {
      progressLayoutRaf = 0;
      syncProgressLayout({ settle: true });
    });
  }

  function bindProgressLayoutListeners() {
    if (progressLayoutBound) return;
    progressLayoutBound = true;
    window.addEventListener('resize', onProgressLayout, { passive: true });
    window.addEventListener('scroll', onProgressLayout, { passive: true, capture: true });
    // Visual viewport changes on Windows snap / DPI / maximize.
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', onProgressLayout, { passive: true });
      window.visualViewport.addEventListener('scroll', onProgressLayout, { passive: true });
    }
  }

  function unbindProgressLayoutListeners() {
    if (!progressLayoutBound) return;
    progressLayoutBound = false;
    clearProgressSettleTimers();
    window.removeEventListener('resize', onProgressLayout);
    window.removeEventListener('scroll', onProgressLayout, true);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener('resize', onProgressLayout);
      window.visualViewport.removeEventListener('scroll', onProgressLayout);
    }
  }

  const PREFIX = '[Reels+]';
  function log(...args) {
    // eslint-disable-next-line no-console
    console.log(PREFIX, ...args);
  }
  function warn(...args) {
    // eslint-disable-next-line no-console
    console.warn(PREFIX, ...args);
  }

  function applySettings(items) {
    if (FEATURES.AUTO_SCROLL) {
      state.autoScroll = items.autoScroll !== undefined
        ? !!items.autoScroll
        : !!items[STORAGE_KEYS.LEGACY_ENABLED];
    } else {
      state.autoScroll = false;
    }
    state.progressBar = items.progressBar !== undefined
      ? !!items.progressBar
      : DEFAULTS.progressBar;
    const rc = parseInt(items.repeatCount, 10);
    state.repeatCount = Number.isFinite(rc) && rc >= 1 ? rc : DEFAULTS.repeatCount;
  }

  function loadSettings() {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get(
          { ...DEFAULTS, [STORAGE_KEYS.LEGACY_ENABLED]: undefined },
          (items) => {
            applySettings(items);
            resolve();
          }
        );
      } catch (_e) {
        try {
          chrome.storage.local.get(
            { ...DEFAULTS, [STORAGE_KEYS.LEGACY_ENABLED]: undefined },
            (items) => {
              applySettings(items);
              resolve();
            }
          );
        } catch (_e2) {
          resolve();
        }
      }
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' && area !== 'local') return;
    let changed = false;
    if (FEATURES.AUTO_SCROLL && changes[STORAGE_KEYS.AUTO_SCROLL]) {
      state.autoScroll = !!changes[STORAGE_KEYS.AUTO_SCROLL].newValue;
      changed = true;
    } else if (FEATURES.AUTO_SCROLL && changes[STORAGE_KEYS.LEGACY_ENABLED] && changes[STORAGE_KEYS.AUTO_SCROLL] === undefined) {
      state.autoScroll = !!changes[STORAGE_KEYS.LEGACY_ENABLED].newValue;
      changed = true;
    }
    if (changes[STORAGE_KEYS.PROGRESS_BAR]) {
      state.progressBar = !!changes[STORAGE_KEYS.PROGRESS_BAR].newValue;
      changed = true;
    }
    if (changes[STORAGE_KEYS.REPEAT_COUNT]) {
      const rc = parseInt(changes[STORAGE_KEYS.REPEAT_COUNT].newValue, 10);
      if (Number.isFinite(rc) && rc >= 1) {
        state.repeatCount = rc;
        changed = true;
      }
    }
    if (changed) {
      if (!FEATURES.AUTO_SCROLL) state.autoScroll = false;
      log('Settings updated →', {
        autoScroll: state.autoScroll,
        progressBar: state.progressBar,
        repeatCount: state.repeatCount,
      });
      recomputeActiveState();
      if (state.active) syncProgressUi(state.activeVideo);
    }
  });

  function isReelsUrl(url = location.href) {
    return REELS_URL_PATTERNS.some((re) => re.test(url));
  }

  function setupNavigationObserver() {
    const wrap = (type) => {
      const orig = history[type];
      history[type] = function (...args) {
        const ret = orig.apply(this, args);
        try {
          window.dispatchEvent(new Event('ig-locationchange'));
        } catch (_e) {}
        return ret;
      };
    };
    wrap('pushState');
    wrap('replaceState');
    window.addEventListener('popstate', () => {
      window.dispatchEvent(new Event('ig-locationchange'));
    });
    window.addEventListener('ig-locationchange', onLocationChanged);
  }

  function onLocationChanged() {
    if (navTimer) clearTimeout(navTimer);
    navTimer = setTimeout(() => {
      recomputeActiveState();
    }, NAV_DEBOUNCE_MS);
  }

  function recomputeActiveState() {
    state.isReelsPage = isReelsUrl();
    const shouldActivate = anyFeatureOn() && state.isReelsPage;
    broadcastStatus();

    if (shouldActivate && !state.active) {
      activate();
    } else if (!shouldActivate && state.active) {
      deactivate();
    } else if (state.active) {
      // Still active — feature mix may have changed.
      syncProgressUi(state.activeVideo);
    }
  }

  function activate() {
    state.active = true;
    state.playCount = 0;
    state.advancing = false;
    log('Activating on Reels page.', {
      autoScroll: state.autoScroll,
      progressBar: state.progressBar,
    });
    syncProgressUi(null);
    bindProgressLayoutListeners();
    attachVideoWatcher();
    setupDomObserver();
  }

  function deactivate() {
    state.active = false;
    log('Deactivating (features off or not on Reels page).');
    detachAllVideoListeners();
    teardownDomObserver();
    unbindProgressLayoutListeners();
    destroyProgressBar();
    if (state.advancingTimer) {
      clearTimeout(state.advancingTimer);
      state.advancingTimer = null;
    }
    state.advancing = false;
    state.activeVideo = null;
    state.playCount = 0;
  }

  function syncProgressUi(video) {
    if (!state.active || !state.progressBar) {
      destroyProgressBar();
      return;
    }
    ensureProgressBar();
    rebuildProgressSegments(true);
    if (video) updateProgressBar(video);
  }

  // -------------------------------------------------------------------------
  // Progress bar overlay (YouTube-style hover scrub)
  // -------------------------------------------------------------------------

  const PROGRESS_HIT_H = 28;

  function ensureProgressBar() {
    if (state.progressHost && document.documentElement.contains(state.progressHost)) {
      rebuildProgressSegments();
      return;
    }

    const host = document.createElement('div');
    host.id = PROGRESS_HOST_ID;
    host.setAttribute('data-reels-plus', 'progress');
    Object.assign(host.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '0',
      height: '0',
      zIndex: String(PROGRESS_Z),
      pointerEvents: 'none',
      overflow: 'visible',
    });

    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .hit {
          position: absolute;
          left: 0;
          top: 0;
          width: 100%;
          height: 100%;
          display: flex;
          align-items: center;
          pointer-events: auto;
          cursor: pointer;
          touch-action: none;
          -webkit-user-select: none;
          user-select: none;
        }
        .wrap {
          position: relative;
          width: 100%;
          display: flex;
          gap: 3px;
          padding: 0;
          box-sizing: border-box;
        }
        .seg {
          flex: 1 1 0;
          height: 2.5px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.35);
          overflow: hidden;
          box-shadow: 0 0 1px rgba(0, 0, 0, 0.35);
          transition: height 0.14s ease;
        }
        .hit:hover .seg,
        .hit.is-hover .seg,
        .hit.is-scrubbing .seg {
          height: 5px;
        }
        .fill {
          height: 100%;
          width: 0%;
          background: #fff;
          border-radius: 999px;
          transform-origin: left center;
          will-change: width;
        }
        .knob {
          position: absolute;
          top: 50%;
          left: 0;
          width: 13px;
          height: 13px;
          margin: 0;
          padding: 0;
          border: none;
          border-radius: 50%;
          background: #fff;
          box-shadow:
            0 0 0 1px rgba(0, 0, 0, 0.12),
            0 1px 3px rgba(0, 0, 0, 0.35);
          opacity: 0;
          transform: translate(-50%, -50%) scale(0.55);
          transition:
            opacity 0.14s ease,
            transform 0.14s ease,
            width 0.14s ease,
            height 0.14s ease;
          pointer-events: none;
          z-index: 2;
        }
        .hit:hover .knob,
        .hit.is-hover .knob,
        .hit.is-scrubbing .knob {
          opacity: 1;
          transform: translate(-50%, -50%) scale(1);
        }
        .hit.is-scrubbing .knob {
          width: 15px;
          height: 15px;
        }
      </style>
      <div class="hit" part="hit">
        <div class="wrap" part="wrap"></div>
        <div class="knob" part="knob" aria-hidden="true"></div>
      </div>
    `;

    document.documentElement.appendChild(host);
    state.progressHost = host;
    state.progressRoot = root;
    state.progressSegCount = 0;
    state.progressScrubbing = false;
    bindProgressScrubListeners();
    rebuildProgressSegments(true);
  }

  function bindProgressScrubListeners() {
    const hit = state.progressRoot && state.progressRoot.querySelector('.hit');
    if (!hit || hit.__reelsPlusScrubBound) return;
    hit.__reelsPlusScrubBound = true;

    const onPointerDown = (e) => {
      if (e.button != null && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      state.progressScrubbing = true;
      hit.classList.add('is-scrubbing');
      try { hit.setPointerCapture(e.pointerId); } catch (_err) {}
      seekProgressFromClientX(e.clientX);
    };

    const onPointerMove = (e) => {
      if (!state.progressScrubbing) return;
      e.preventDefault();
      e.stopPropagation();
      seekProgressFromClientX(e.clientX);
    };

    const endScrub = (e) => {
      if (!state.progressScrubbing) return;
      if (e) {
        e.preventDefault();
        e.stopPropagation();
        try { hit.releasePointerCapture(e.pointerId); } catch (_err) {}
      }
      state.progressScrubbing = false;
      hit.classList.remove('is-scrubbing');
      if (state.activeVideo) updateProgressBar(state.activeVideo);
    };

    // Keep hover visuals when the pointer is near the thin bar (hit is tall).
    const onPointerEnter = () => hit.classList.add('is-hover');
    const onPointerLeave = () => {
      if (!state.progressScrubbing) hit.classList.remove('is-hover');
    };

    hit.addEventListener('pointerdown', onPointerDown);
    hit.addEventListener('pointermove', onPointerMove);
    hit.addEventListener('pointerup', endScrub);
    hit.addEventListener('pointercancel', endScrub);
    hit.addEventListener('lostpointercapture', endScrub);
    hit.addEventListener('pointerenter', onPointerEnter);
    hit.addEventListener('pointerleave', onPointerLeave);
    // Avoid Instagram stealing the gesture on touch / click.
    hit.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
    hit.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); });

    state.progressScrubCleanup = () => {
      hit.removeEventListener('pointerdown', onPointerDown);
      hit.removeEventListener('pointermove', onPointerMove);
      hit.removeEventListener('pointerup', endScrub);
      hit.removeEventListener('pointercancel', endScrub);
      hit.removeEventListener('lostpointercapture', endScrub);
      hit.removeEventListener('pointerenter', onPointerEnter);
      hit.removeEventListener('pointerleave', onPointerLeave);
    };
  }

  function seekProgressFromClientX(clientX) {
    let video = state.activeVideo;
    if (video && (!video.isConnected || !isVideoUsable(video))) {
      refreshActiveVideo({ resetCount: false });
      video = state.activeVideo;
    }
    if (!video || !state.progressRoot) return;
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;

    const segs = state.progressRoot.querySelectorAll('.seg');
    if (!segs.length) return;

    let targetSeg = 0;
    let ratio = 0;
    const first = segs[0].getBoundingClientRect();
    const last = segs[segs.length - 1].getBoundingClientRect();

    if (clientX <= first.left) {
      targetSeg = 0;
      ratio = 0;
    } else if (clientX >= last.right) {
      targetSeg = segs.length - 1;
      ratio = 1;
    } else {
      let resolved = false;
      for (let i = 0; i < segs.length; i++) {
        const r = segs[i].getBoundingClientRect();
        if (clientX >= r.left && clientX <= r.right) {
          targetSeg = i;
          ratio = r.width > 0 ? (clientX - r.left) / r.width : 0;
          resolved = true;
          break;
        }
        if (i < segs.length - 1) {
          const next = segs[i + 1].getBoundingClientRect();
          if (clientX > r.right && clientX < next.left) {
            const mid = (r.right + next.left) / 2;
            if (clientX < mid) {
              targetSeg = i;
              ratio = 1;
            } else {
              targetSeg = i + 1;
              ratio = 0;
            }
            resolved = true;
            break;
          }
        }
      }
      if (!resolved) {
        targetSeg = 0;
        ratio = 0;
      }
    }

    ratio = Math.max(0, Math.min(1, ratio));

    if (state.autoScroll) {
      const maxIdx = Math.max(0, (state.repeatCount | 0) - 1);
      const nextCount = Math.min(targetSeg, maxIdx);
      if (nextCount !== state.playCount) {
        state.playCount = nextCount;
        broadcastStatus();
      }
      state.videoEndedFired = false;
    }

    try {
      video.currentTime = ratio * duration;
    } catch (_e) {
      warn('Failed to seek the Reel.');
      return;
    }

    updateProgressBar(video);
  }

  function destroyProgressBar() {
    if (state.progressRaf) {
      cancelAnimationFrame(state.progressRaf);
      state.progressRaf = 0;
    }
    if (typeof state.progressScrubCleanup === 'function') {
      try { state.progressScrubCleanup(); } catch (_e) {}
    }
    state.progressScrubCleanup = null;
    state.progressScrubbing = false;
    if (state.progressHost) {
      try { state.progressHost.remove(); } catch (_e) {}
    }
    state.progressHost = null;
    state.progressRoot = null;
    state.progressSegCount = 0;
  }

  function rebuildProgressSegments(force = false) {
    if (!state.progressRoot) return;
    const wrap = state.progressRoot.querySelector('.wrap');
    if (!wrap) return;
    const n = progressSegmentCount();
    if (!force && n === state.progressSegCount && wrap.children.length === n) return;

    wrap.textContent = '';
    for (let i = 0; i < n; i++) {
      const seg = document.createElement('div');
      seg.className = 'seg';
      const fill = document.createElement('div');
      fill.className = 'fill';
      seg.appendChild(fill);
      wrap.appendChild(seg);
    }
    state.progressSegCount = n;
  }

  function positionProgressBar(video) {
    if (!state.progressHost || !video) return;
    try {
      if (!video.isConnected) {
        state.progressHost.style.opacity = '0';
        return;
      }
      const r = video.getBoundingClientRect();
      if (r.width < 40 || r.height < 40) {
        state.progressHost.style.opacity = '0';
        return;
      }
      const padX = Math.max(10, Math.min(16, r.width * 0.04));
      // Center the tall hit zone on the visual bar near the top of the reel.
      const inset = Math.max(8, Math.min(14, r.height * 0.02));
      const barY = r.top + inset;
      const top = barY - (PROGRESS_HIT_H - 5) / 2;
      Object.assign(state.progressHost.style, {
        opacity: '1',
        top: `${top}px`,
        left: `${r.left + padX}px`,
        width: `${Math.max(0, r.width - padX * 2)}px`,
        height: `${PROGRESS_HIT_H}px`,
        pointerEvents: 'none',
      });
    } catch (_e) {
      state.progressHost.style.opacity = '0';
    }
  }

  function positionProgressKnob(ratio, activeIdx) {
    if (!state.progressRoot) return;
    const knob = state.progressRoot.querySelector('.knob');
    const wrap = state.progressRoot.querySelector('.wrap');
    const segs = state.progressRoot.querySelectorAll('.seg');
    if (!knob || !wrap || !segs.length) return;

    const idx = Math.max(0, Math.min(segs.length - 1, activeIdx | 0));
    const seg = segs[idx];
    const wrapRect = wrap.getBoundingClientRect();
    const segRect = seg.getBoundingClientRect();
    if (wrapRect.width <= 0) return;

    const x = (segRect.left - wrapRect.left) + segRect.width * Math.max(0, Math.min(1, ratio));
    knob.style.left = `${x}px`;
  }

  function updateProgressBar(video) {
    if (!state.active || !state.progressBar) return;

    // Self-heal only when the bound Reel has clearly left the primary slot.
    if (video && video === state.activeVideo && !isVideoPrimary(video)) {
      const next = findReelsVideo();
      if (next && next !== video && isVideoPrimary(next)) {
        bindVideo(next);
        resetPlayCount();
        return;
      }
      // Still connected but mid-reflow / partially off — keep updating if possible.
      if (!video.isConnected) {
        if (state.progressHost) state.progressHost.style.opacity = '0';
        return;
      }
    }

    ensureProgressBar();
    rebuildProgressSegments();
    if (!state.progressRoot) return;

    const fills = state.progressRoot.querySelectorAll('.seg .fill');
    if (!fills.length) return;

    const duration = video && Number.isFinite(video.duration) && video.duration > 0
      ? video.duration
      : 0;
    const ratio = duration
      ? Math.max(0, Math.min(1, (video.currentTime || 0) / duration))
      : 0;
    const completed = state.autoScroll ? Math.max(0, state.playCount | 0) : 0;

    fills.forEach((fill, i) => {
      let pct = 0;
      if (i < completed) pct = 100;
      else if (i === completed) pct = ratio * 100;
      else pct = 0;
      fill.style.width = `${pct}%`;
    });

    positionProgressKnob(ratio, completed);
    positionProgressBar(video || state.activeVideo);
  }

  function scheduleProgressTick(video) {
    if (state.progressRaf) return;
    state.progressRaf = requestAnimationFrame(() => {
      state.progressRaf = 0;
      updateProgressBar(video || state.activeVideo);
    });
  }

  function broadcastStatus() {
    try {
      chrome.runtime.sendMessage({
        type: 'IG_REELS_STATUS',
        payload: {
          onReelsPage: state.isReelsPage,
          autoScroll: state.autoScroll,
          progressBar: state.progressBar,
          enabled: anyFeatureOn(), // back-compat for older popups
          active: state.active,
          playCount: state.playCount,
          repeatCount: state.repeatCount,
        },
      });
    } catch (_e) {}
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'IG_REELS_REQUEST_STATUS') {
      broadcastStatus();
      sendResponse({ ok: true });
    }
    return true;
  });

  function queryVisibleArea(el) {
    try {
      const r = el.getBoundingClientRect();
      const left = Math.max(0, r.left);
      const top = Math.max(0, r.top);
      const right = Math.min(window.innerWidth, r.right);
      const bottom = Math.min(window.innerHeight, r.bottom);
      return Math.max(0, right - left) * Math.max(0, bottom - top);
    } catch (_e) {
      return 0;
    }
  }

  function isLikelyInView(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 80 || r.height < 80) return false;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    return cx >= 0 && cx <= window.innerWidth && cy >= 0 && cy <= window.innerHeight;
  }

  function findReelsVideo() {
    let candidates = [];
    for (const sel of VIDEO_SELECTORS) {
      try {
        const nodes = document.querySelectorAll(sel);
        if (nodes && nodes.length) {
          for (const n of nodes) {
            if (n && n.tagName === 'VIDEO' && n.isConnected && !candidates.includes(n)) {
              candidates.push(n);
            }
          }
        }
      } catch (_e) {}
    }
    if (!candidates.length) return null;

    let best = null;
    let bestScore = -1;
    for (const v of candidates) {
      if (!isVideoUsable(v) && !isLikelyInView(v)) continue;
      let score = queryVisibleArea(v);
      if (score <= 0) continue;
      if (isLikelyInView(v)) score *= 2;
      if (isVideoPrimary(v)) score *= 1.35;
      else if (isVideoUsable(v)) score *= 1.1;
      if (!v.paused && !v.ended) score *= 1.5;
      // Prefer the currently bound video when scores are close (avoid flip-flop).
      if (v === state.activeVideo) score *= 1.1;
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    }
    if (best) return best;
    // Prefer a primary/in-view candidate; last resort: largest connected video.
    return (
      candidates.find((v) => isVideoPrimary(v))
      || candidates.find((v) => isLikelyInView(v))
      || candidates.find((v) => v.isConnected && v.getBoundingClientRect().width >= 80)
      || null
    );
  }

  function setupDomObserver() {
    if (mutationObserver) return;
    try {
      mutationObserver = new MutationObserver(() => {
        if (domObserverTimer) clearTimeout(domObserverTimer);
        domObserverTimer = setTimeout(() => {
          if (!state.active) return;
          const prev = state.activeVideo;
          refreshActiveVideo({ resetCount: true });
          // Even if the same <video> node, Instagram may have reflowed it.
          if (state.progressBar && state.activeVideo) {
            if (state.activeVideo === prev) syncProgressLayout({ settle: true });
          }
        }, DOM_OBSERVE_DEBOUNCE_MS);
      });
      mutationObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    } catch (_e) {
      warn('MutationObserver unavailable; falling back to periodic check.');
    }
  }

  function teardownDomObserver() {
    if (mutationObserver) {
      try { mutationObserver.disconnect(); } catch (_e) {}
      mutationObserver = null;
    }
    if (domObserverTimer) {
      clearTimeout(domObserverTimer);
      domObserverTimer = null;
    }
  }

  function attachVideoWatcher() {
    const v = findReelsVideo();
    if (v) {
      bindVideo(v);
    } else {
      setupDomObserver();
    }
  }

  function bindVideo(video) {
    if (!video) return;
    if (state.activeVideo === video) {
      if (state.progressBar) updateProgressBar(video);
      return;
    }

    if (state.activeVideo && state.activeVideo !== video) {
      detachVideoListeners(state.activeVideo);
    }
    state.activeVideo = video;
    state.videoEndedFired = false;
    // Clear a stuck scrub if the Reel swapped mid-drag.
    state.progressScrubbing = false;
    if (state.progressRoot) {
      const hit = state.progressRoot.querySelector('.hit');
      if (hit) hit.classList.remove('is-scrubbing', 'is-hover');
    }

    const onTimeUpdate = () => {
      if (state.progressBar) scheduleProgressTick(video);
      handleTimeUpdate(video);
    };
    const onEnded = () => handleEnded(video);
    const onPlay = () => {
      if (state.progressBar) updateProgressBar(video);
      broadcastStatus();
    };
    const onPause = () => {
      if (state.progressBar) updateProgressBar(video);
      broadcastStatus();
    };
    const onSeeked = () => {
      if (state.progressBar) updateProgressBar(video);
    };
    const onMeta = () => {
      if (state.progressBar && state.activeVideo === video) {
        updateProgressBar(video);
        positionProgressBar(video);
      }
    };

    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('ended', onEnded);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('durationchange', onMeta);
    video.addEventListener('resize', onMeta);

    state.listeners.set(video, {
      timeupdate: onTimeUpdate,
      ended: onEnded,
      play: onPlay,
      pause: onPause,
      seeked: onSeeked,
      loadedmetadata: onMeta,
      durationchange: onMeta,
      resize: onMeta,
    });

    log('Bound to active Reel video.', {
      duration: video.duration,
      currentTime: video.currentTime,
    });
    if (state.progressBar) {
      updateProgressBar(video);
      // Async settle only — avoid re-entering bind via syncProgressLayout here.
      clearProgressSettleTimers();
      for (const ms of [50, 150, 350, 700]) {
        progressSettleTimers.push(setTimeout(() => {
          if (!state.active || !state.progressBar) return;
          refreshActiveVideo({ resetCount: false });
          const v = state.activeVideo;
          if (v && v.isConnected) {
            positionProgressBar(v);
            updateProgressBar(v);
          }
        }, ms));
      }
    }
    broadcastStatus();
  }

  function detachVideoListeners(video) {
    if (!video) return;
    const refs = state.listeners.get(video);
    if (refs) {
      try {
        video.removeEventListener('timeupdate', refs.timeupdate);
        video.removeEventListener('ended', refs.ended);
        video.removeEventListener('play', refs.play);
        video.removeEventListener('pause', refs.pause);
        if (refs.seeked) video.removeEventListener('seeked', refs.seeked);
        if (refs.loadedmetadata) video.removeEventListener('loadedmetadata', refs.loadedmetadata);
        if (refs.durationchange) video.removeEventListener('durationchange', refs.durationchange);
        if (refs.resize) video.removeEventListener('resize', refs.resize);
      } catch (_e) {}
      state.listeners.delete(video);
    }
  }

  function detachAllVideoListeners() {
    for (const v of state.listeners.keys()) {
      detachVideoListeners(v);
    }
    state.listeners.clear();
    state.activeVideo = null;
  }

  function handleTimeUpdate(video) {
    if (!state.active || !state.autoScroll || state.advancing) return;
    if (state.videoEndedFired) return;
    const d = video.duration;
    if (Number.isFinite(d) && d > 0 && video.currentTime >= d - END_THRESHOLD_SECONDS) {
      onPlayComplete(video);
    }
  }

  function handleEnded(video) {
    if (!state.active || !state.autoScroll || state.advancing) return;
    onPlayComplete(video);
  }

  function onPlayComplete(video) {
    if (!state.autoScroll) return;
    if (state.videoEndedFired) return;
    state.videoEndedFired = true;
    state.playCount += 1;
    log(`Play complete. playCount=${state.playCount} / target=${state.repeatCount}`);
    if (state.progressBar) updateProgressBar(video);
    broadcastStatus();

    if (state.playCount < state.repeatCount) {
      replayFromStart(video);
    } else {
      advanceToNext();
    }
  }

  function replayFromStart(video) {
    state.videoEndedFired = false;
    try {
      video.currentTime = 0;
      const p = video.play();
      if (p && typeof p.then === 'function') {
        p.catch(() => {});
      }
    } catch (_e) {
      warn('Failed to seek/replay the Reel.');
    }
  }

  function resetPlayCount() {
    state.playCount = 0;
    state.videoEndedFired = false;
    log('New Reel detected → counter reset.');
    if (state.progressBar) updateProgressBar(state.activeVideo);
    broadcastStatus();
  }

  function advanceToNext() {
    if (!state.autoScroll) return;
    if (state.advancing) return;
    state.advancing = true;
    broadcastStatus();

    state.advancingTimer = setTimeout(() => {
      state.advancing = false;
      state.advancingTimer = null;
    }, ADVANCE_COOLDOWN_MS);

    if (clickNextButton()) {
      log('Advanced via Next button click.');
      afterAdvance();
      return;
    }

    if (simulateKeyNext()) {
      log('Advanced via keyboard.');
      afterAdvance();
      return;
    }

    if (scrollContainerNext()) {
      log('Advanced via programmatic scroll.');
      afterAdvance();
      return;
    }

    warn('Could not advance to the next Reel. End of feed or selectors changed.');
  }

  function afterAdvance() {
    setTimeout(() => {
      if (!state.active) return;
      refreshActiveVideo({ resetCount: true });
      syncProgressLayout({ settle: true });
    }, VIDEO_SETTLE_MS);
  }

  function findNextButton() {
    for (const sel of NEXT_BUTTON_SELECTORS) {
      try {
        const el = document.querySelector(sel);
        if (el) {
          let target = el;
          for (let i = 0; i < 3 && target; i++) {
            const r = target.getBoundingClientRect();
            if (r.width >= 16 && r.height >= 16) {
              const role = target.getAttribute && target.getAttribute('role');
              const tag = target.tagName && target.tagName.toLowerCase();
              if (tag === 'button' || role === 'button') return target;
            }
            target = target.parentElement;
          }
          return el;
        }
      } catch (_e) {}
    }
    return null;
  }

  function clickNextButton() {
    const btn = findNextButton();
    if (!btn) return false;
    try {
      const r = btn.getBoundingClientRect();
      const opts = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
      };
      btn.dispatchEvent(new MouseEvent('mouseover', opts));
      btn.dispatchEvent(new MouseEvent('mousedown', opts));
      btn.dispatchEvent(new MouseEvent('mouseup', opts));
      btn.dispatchEvent(new MouseEvent('click', opts));
      return true;
    } catch (_e) {
      return false;
    }
  }

  function simulateKeyNext() {
    try {
      const opts = { bubbles: true, cancelable: true, keyCode: 40, which: 40 };
      const send = (type) => {
        document.dispatchEvent(new KeyboardEvent(type, { ...opts, key: 'ArrowDown', code: 'ArrowDown' }));
      };
      send('keydown');
      send('keypress');
      send('keyup');
      const pd = { bubbles: true, cancelable: true, key: 'PageDown', code: 'PageDown' };
      document.dispatchEvent(new KeyboardEvent('keydown', pd));
      document.dispatchEvent(new KeyboardEvent('keyup', pd));
      return true;
    } catch (_e) {
      return false;
    }
  }

  function findReelsScrollContainer() {
    const candidates = [
      'main[role="main"]',
      'section[role="main"]',
      'div[data-scroll-container]',
      'article',
      'main',
    ];
    for (const sel of candidates) {
      try {
        const el = document.querySelector(sel);
        if (el) {
          const r = el.getBoundingClientRect();
          if (r.height > 200) return el;
        }
      } catch (_e) {}
    }
    return document.scrollingElement || document.documentElement;
  }

  function scrollContainerNext() {
    try {
      const container = findReelsScrollContainer();
      const amount = Math.max(window.innerHeight * 0.85, 400);
      container.scrollBy({ top: amount, behavior: 'smooth' });
      return true;
    } catch (_e) {
      return false;
    }
  }

  function setupUserActivityDetection() {
    let userScrollTimer = null;
    const onUserScroll = () => {
      if (!state.active) return;
      if (userScrollTimer) clearTimeout(userScrollTimer);
      userScrollTimer = setTimeout(() => {
        const prev = state.activeVideo;
        refreshActiveVideo({ resetCount: true });
        if (state.progressBar && state.activeVideo === prev) {
          syncProgressLayout({ settle: true });
        }
      }, 250);
    };
    window.addEventListener('wheel', onUserScroll, { passive: true });
    window.addEventListener('touchend', onUserScroll, { passive: true });
    window.addEventListener('keydown', (e) => {
      if (!state.active) return;
      if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', ' '].includes(e.key)) {
        onUserScroll();
      }
    }, { passive: true });
  }

  async function init() {
    setupNavigationObserver();
    setupUserActivityDetection();
    await loadSettings();
    state.isReelsPage = isReelsUrl();
    recomputeActiveState();
    log('Initialized.', {
      autoScroll: state.autoScroll,
      progressBar: state.progressBar,
      repeatCount: state.repeatCount,
      onReelsPage: state.isReelsPage,
    });
  }

  init();
})();
