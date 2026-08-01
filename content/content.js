/*
 * Reels+ — Content Script
 * ----------------------------------------------------------------------------
 * Quality-of-life upgrades for Instagram web Reels:
 *  - Progress bar (Stories-style segments, YouTube-style hover scrub)
 *  - Optional auto-advance after N full plays (holds while comments are open)
 *
 * Design goals:
 *  - Features are independently toggleable.
 *  - Event-driven (video events + MutationObserver), plus a light location
 *    poll so Instagram SPA navigations are detected across the isolated world.
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
    'button[aria-label="Navigate to next Reel"]',
    'button[aria-label="Next"]',
    'button[aria-label="Go to next video"]',
    'button[aria-label*="Next" i]',
    'div[role="button"][aria-label="Navigate to next Reel"]',
    'div[role="button"][aria-label="Next"]',
    'button svg[aria-label="Next"]',
    'div[role="button"][aria-label*="Next" i]',
  ];

  // Comments panel signals (Instagram DOM drifts — prefer role/aria over classes).
  const COMMENT_DIALOG_SELECTOR = '[role="dialog"]';
  const COMMENT_COMPOSE_SELECTORS = [
    'textarea[placeholder*="Add a comment" i]',
    'textarea[aria-label*="Add a comment" i]',
    'textarea[placeholder*="comment" i]',
    'textarea[aria-label*="comment" i]',
  ];
  const COMMENT_CONTROL_EXPANDED_SELECTOR =
    '[aria-expanded="true"] svg[aria-label*="Comment" i]';

  const END_THRESHOLD_SECONDS = 0.3;
  const NAV_DEBOUNCE_MS = 450;
  const LOCATION_POLL_MS = 400;
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
    activeReelSrc: '',
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
    /** Blocks end-detection while restarting a Reel left at EOF (#3). */
    pendingFreshStart: false,

    /** True while the Reels comments panel is open. */
    commentsOpen: false,
    /** Play finished while comments were open — advance deferred until close. */
    heldForComments: false,
  };

  let mutationObserver = null;
  let domObserverTimer = null;
  let navTimer = null;
  let lastSeenHref = '';
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

  function getVideoSrcKey(video) {
    if (!video) return '';
    try {
      return video.currentSrc || video.src || '';
    } catch (_e) {
      return '';
    }
  }

  function isMidRepeatCycle() {
    if (!state.autoScroll) return false;
    const target = Math.max(1, state.repeatCount | 0);
    return state.playCount > 0 && state.playCount < target;
  }

  /** True when the bound video is a different Reel asset (not a DOM node swap). */
  function shouldResetPlayCountForVideo(nextVideo) {
    if (!nextVideo) return false;
    const nextSrc = getVideoSrcKey(nextVideo);
    const prevSrc = state.activeReelSrc || getVideoSrcKey(state.activeVideo);
    if (nextSrc && prevSrc) {
      if (nextSrc === prevSrc) return false;
      return true;
    }
    if (isMidRepeatCycle()) return false;
    // Finished the repeat cycle (e.g. auto-advance pending) — reset even if the
    // next asset has not published currentSrc yet (#4 play-to-end progress bar).
    const target = Math.max(1, state.repeatCount | 0);
    if (state.autoScroll && state.playCount >= target) return true;
    return !!nextSrc;
  }

  function syncActiveReelSrc(video) {
    if (!video || video !== state.activeVideo) return;
    const src = getVideoSrcKey(video);
    if (src) state.activeReelSrc = src;
  }

  function resolveReplayVideo(video) {
    const preferSrc = state.activeReelSrc || getVideoSrcKey(video);
    if (preferSrc) state.activeReelSrc = preferSrc;

    if (video && video.isConnected) {
      const src = getVideoSrcKey(video);
      if (!preferSrc || !src || src === preferSrc) return video;
    }

    return findReelsVideo({ preferSrc }) || video;
  }

  function refreshActiveVideo(opts = {}) {
    const { resetCount = false, allowReelChange = false } = opts;
    if (!state.active) return null;

    const preferSrc = isMidRepeatCycle() && !allowReelChange ? state.activeReelSrc : '';
    if (isMidRepeatCycle() && !allowReelChange && state.activeVideo && state.activeVideo.isConnected) {
      if (state.progressBar) updateProgressBar(state.activeVideo);
      return state.activeVideo;
    }

    const next = findReelsVideo({ preferSrc });
    if (next && next !== state.activeVideo) {
      bindVideo(next);
      if (resetCount && shouldResetPlayCountForVideo(next)) resetPlayCount();
    } else if (next) {
      // Same <video> node may have swapped assets on navigation.
      if (resetCount && shouldResetPlayCountForVideo(next)) {
        resetPlayCount();
      } else if (state.progressBar) {
        updateProgressBar(next);
      }
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
    // popstate crosses the content-script isolated world (shared DOM events).
    window.addEventListener('popstate', onLocationChanged);

    // Instagram SPA routing (e.g. Messages → Reels) updates location via the
    // page world's History API. Content-script wraps of history.pushState do
    // not see those calls, and pushState never fires popstate — so we poll.
    lastSeenHref = location.href;
    setInterval(() => {
      const href = location.href;
      if (href === lastSeenHref) return;
      lastSeenHref = href;
      onLocationChanged();
    }, LOCATION_POLL_MS);
  }

  function onLocationChanged() {
    lastSeenHref = location.href;
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
      // URL changed between Reels (e.g. Instagram auto-advance after natural end).
      refreshActiveVideo({ resetCount: true, allowReelChange: true });
      syncProgressLayout({ settle: true });
    }
  }

  function activate() {
    state.active = true;
    state.playCount = 0;
    state.advancing = false;
    state.commentsOpen = false;
    state.heldForComments = false;
    log('Activating on Reels page.', {
      autoScroll: state.autoScroll,
      progressBar: state.progressBar,
    });
    syncProgressUi(null);
    bindProgressLayoutListeners();
    attachVideoWatcher();
    setupDomObserver();
    syncCommentsPanelState();
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
    state.activeReelSrc = '';
    state.playCount = 0;
    state.videoEndedFired = false;
    state.pendingFreshStart = false;
    state.commentsOpen = false;
    state.heldForComments = false;
  }

  function syncProgressUi(video) {
    if (!state.active || !state.progressBar) {
      destroyProgressBar();
      return;
    }
    ensureProgressBar();
    rebuildProgressSegments(true);
    if (video) {
      updateProgressBar(video);
      if (!video.paused && !video.ended) startProgressLoop();
    }
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
          width: 100%;
          background: #fff;
          border-radius: 999px;
          transform: scaleX(0);
          transform-origin: left center;
          will-change: transform;
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
    cancelProgressTick();
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

  function cancelProgressTick() {
    if (state.progressRaf) {
      cancelAnimationFrame(state.progressRaf);
      state.progressRaf = 0;
    }
  }

  function progressTickLoop() {
    state.progressRaf = 0;
    if (!state.active || !state.progressBar || !state.activeVideo) return;
    const video = state.activeVideo;
    if (video.paused || video.ended) return;
    updateProgressBar(video);
    state.progressRaf = requestAnimationFrame(progressTickLoop);
  }

  function startProgressLoop() {
    if (state.progressRaf) return;
    if (!state.active || !state.progressBar || !state.activeVideo) return;
    const video = state.activeVideo;
    if (video.paused || video.ended) return;
    state.progressRaf = requestAnimationFrame(progressTickLoop);
  }

  function updateProgressBar(video) {
    if (!state.active || !state.progressBar) return;
    // Ignore paints from a Reel we already unbound (stale scrub RAF / timeupdate).
    if (video && state.activeVideo && video !== state.activeVideo) return;
    video = video || state.activeVideo;

    // Self-heal only when the bound Reel has clearly left the primary slot.
    if (video && video === state.activeVideo && !isVideoPrimary(video)) {
      if (!isMidRepeatCycle()) {
        const next = findReelsVideo();
        if (next && next !== video && isVideoPrimary(next)) {
          bindVideo(next);
          if (shouldResetPlayCountForVideo(next)) resetPlayCount();
          return;
        }
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
    let completed = state.autoScroll ? Math.max(0, state.playCount | 0) : 0;
    // playCount reaches repeatCount when ready to advance (or held for comments).
    // Keep painting the last segment from the live ratio so a looped reel does
    // not look stuck at 100% white while still playing.
    if (fills.length > 0 && completed >= fills.length) {
      completed = fills.length - 1;
    }

    fills.forEach((fill, i) => {
      let pct = 0;
      if (i < completed) pct = 100;
      else if (i === completed) pct = ratio * 100;
      else pct = 0;
      fill.style.transform = `scaleX(${pct / 100})`;
    });

    positionProgressKnob(ratio, completed);
    positionProgressBar(video || state.activeVideo);
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

  function findReelsVideo(opts = {}) {
    let preferSrc = opts.preferSrc || '';
    if (!preferSrc && isMidRepeatCycle() && state.activeReelSrc) {
      preferSrc = state.activeReelSrc;
    }

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
      const vSrc = getVideoSrcKey(v);
      if (preferSrc && vSrc && vSrc !== preferSrc) continue;
      if (!isVideoUsable(v) && !isLikelyInView(v)) continue;
      let score = queryVisibleArea(v);
      if (score <= 0) continue;
      if (isLikelyInView(v)) score *= 2;
      if (isVideoPrimary(v)) score *= 1.35;
      else if (isVideoUsable(v)) score *= 1.1;
      if (!v.paused && !v.ended) score *= 1.5;
      // Prefer the currently bound video when scores are close (avoid flip-flop).
      if (v === state.activeVideo) score *= 1.1;
      if (preferSrc && vSrc === preferSrc) score *= 4;
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    }
    if (best) return best;

    if (preferSrc && state.activeVideo && state.activeVideo.isConnected) {
      const activeSrc = getVideoSrcKey(state.activeVideo);
      if (!activeSrc || activeSrc === preferSrc) return state.activeVideo;
    }

    // Prefer a primary/in-view candidate; last resort: largest connected video.
    const filtered = preferSrc
      ? candidates.filter((v) => {
        const vSrc = getVideoSrcKey(v);
        return !vSrc || vSrc === preferSrc;
      })
      : candidates;
    return (
      filtered.find((v) => isVideoPrimary(v))
      || filtered.find((v) => isLikelyInView(v))
      || filtered.find((v) => v.isConnected && v.getBoundingClientRect().width >= 80)
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
          syncCommentsPanelState();
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
      const src = getVideoSrcKey(video);
      if (src && state.activeReelSrc && src !== state.activeReelSrc) {
        state.activeReelSrc = src;
        resetPlayCount();
      } else if (state.progressBar) {
        updateProgressBar(video);
      }
      return;
    }

    if (isMidRepeatCycle() && state.activeReelSrc) {
      const nextSrc = getVideoSrcKey(video);
      if (nextSrc && nextSrc !== state.activeReelSrc) return;
    }

    const prevSrc = getVideoSrcKey(state.activeVideo);
    const nextSrc = getVideoSrcKey(video);
    const sameReel = !!(nextSrc && prevSrc && nextSrc === prevSrc);
    const preserveEndState = sameReel && isMidRepeatCycle();
    const prevEndedFired = state.videoEndedFired;

    // Cancel any pending RAF from the previous Reel before rebinding (#2).
    cancelProgressTick();

    if (state.activeVideo && state.activeVideo !== video) {
      detachVideoListeners(state.activeVideo);
    }
    state.activeVideo = video;
    state.activeReelSrc = nextSrc || state.activeReelSrc;
    state.videoEndedFired = preserveEndState ? prevEndedFired : false;
    if (!preserveEndState) state.pendingFreshStart = false;
    // Clear a stuck scrub if the Reel swapped mid-drag.
    state.progressScrubbing = false;
    if (state.progressRoot) {
      const hit = state.progressRoot.querySelector('.hit');
      if (hit) hit.classList.remove('is-scrubbing', 'is-hover');
    }

    const onTimeUpdate = () => {
      if (video !== state.activeVideo) return;
      clearPendingFreshStart(video);
      // Keep the progress RAF alive across silent loops (seek without play).
      if (state.progressBar && !video.paused && !video.ended) startProgressLoop();
      handleTimeUpdate(video);
    };
    const onEnded = () => {
      if (video !== state.activeVideo) return;
      cancelProgressTick();
      handleEnded(video);
    };
    const onPlay = () => {
      if (video !== state.activeVideo) return;
      clearPendingFreshStart(video);
      if (state.progressBar) {
        updateProgressBar(video);
        startProgressLoop();
      }
      broadcastStatus();
    };
    const onPause = () => {
      if (video !== state.activeVideo) return;
      cancelProgressTick();
      if (state.progressBar) updateProgressBar(video);
      broadcastStatus();
    };
    const onSeeked = () => {
      if (video !== state.activeVideo) return;
      clearPendingFreshStart(video);
      if (state.progressBar) {
        updateProgressBar(video);
        // Instagram may loop a Reel via seek without a play event; restart RAF.
        if (!video.paused && !video.ended) startProgressLoop();
      }
    };
    const onMeta = () => {
      if (video !== state.activeVideo) return;
      syncActiveReelSrc(video);
      if (state.progressBar) {
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
      if (!video.paused && !video.ended) startProgressLoop();
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
    // If this Reel was left at EOF (auto-advance then Previous), restart now (#3).
    // resetPlayCount also does this; calling here covers bind-without-reset races.
    if (
      state.autoScroll
      && !preserveEndState
      && !sameReel
      && isNearPlaybackEnd(video)
      && !state.pendingFreshStart
    ) {
      prepareFreshPlayback(video);
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
    state.activeReelSrc = '';
  }

  function handleTimeUpdate(video) {
    if (!state.active || !state.autoScroll || state.advancing) return;
    if (video !== state.activeVideo) return;
    if (state.pendingFreshStart) return;
    if (state.videoEndedFired) return;
    const d = video.duration;
    if (Number.isFinite(d) && d > 0 && video.currentTime >= d - END_THRESHOLD_SECONDS) {
      onPlayComplete(video);
    }
  }

  function schedulePostEndRebind() {
    setTimeout(() => {
      if (!state.active) return;
      refreshActiveVideo({ resetCount: true, allowReelChange: true });
      syncProgressLayout({ settle: true });
    }, VIDEO_SETTLE_MS);
  }

  function handleEnded(video) {
    if (video !== state.activeVideo) return;
    if (state.pendingFreshStart) return;
    // Progress-only: Instagram may auto-advance after natural end without a user
    // scroll event — rebind once the next Reel settles (#4).
    if (state.progressBar && !state.autoScroll) {
      schedulePostEndRebind();
      return;
    }
    if (!state.active || !state.autoScroll || state.advancing) return;
    onPlayComplete(video);
  }

  function onPlayComplete(video) {
    if (!state.autoScroll) return;
    if (video && video !== state.activeVideo) return;
    if (state.pendingFreshStart) return;
    if (state.videoEndedFired) return;
    state.videoEndedFired = true;
    state.playCount += 1;
    syncActiveReelSrc(video);
    log(`Play complete. playCount=${state.playCount} / target=${state.repeatCount}`);
    if (state.progressBar) updateProgressBar(video);
    broadcastStatus();

    if (state.playCount < state.repeatCount) {
      replayFromStart(video);
    } else if (isCommentsOpen()) {
      state.heldForComments = true;
      state.commentsOpen = true;
      log('Comments open — holding auto-advance.');
      broadcastStatus();
    } else {
      advanceToNext();
    }
  }

  function replayFromStart(video) {
    state.videoEndedFired = false;
    const target = resolveReplayVideo(video);
    if (target && target !== state.activeVideo) bindVideo(target);
    if (!target) {
      warn('Failed to find Reel video for replay.');
      return;
    }
    log('Replaying Reel from start.');
    try {
      target.currentTime = 0;
      const p = target.play();
      if (p && typeof p.then === 'function') {
        p.catch(() => {});
      }
    } catch (_e) {
      warn('Failed to seek/replay the Reel.');
    }
  }

  function isNearPlaybackEnd(video) {
    if (!video) return false;
    if (video.ended) return true;
    const d = video.duration;
    return Number.isFinite(d) && d > 0 && video.currentTime >= d - END_THRESHOLD_SECONDS;
  }

  /**
   * Restart a Reel left at end-of-play (e.g. after auto-advance, then Previous).
   * Suppresses completion until currentTime leaves the end zone so a stale
   * timeupdate/ended cannot immediately re-advance (#3).
   */
  function prepareFreshPlayback(video) {
    if (!video) return;
    state.pendingFreshStart = true;
    state.videoEndedFired = true;
    try {
      video.currentTime = 0;
      const p = video.play();
      if (p && typeof p.then === 'function') p.catch(() => {});
    } catch (_e) {
      state.pendingFreshStart = false;
      state.videoEndedFired = false;
      warn('Failed to restart Reel from start.');
    }
  }

  function clearPendingFreshStart(video) {
    if (!state.pendingFreshStart) return;
    if (video && video !== state.activeVideo) return;
    // Seek landed (or Instagram restarted) — arm auto-scroll for a full play.
    if (!video || !isNearPlaybackEnd(video)) {
      state.pendingFreshStart = false;
      state.videoEndedFired = false;
    }
  }

  function resetPlayCount() {
    state.playCount = 0;
    state.activeReelSrc = getVideoSrcKey(state.activeVideo);
    log('New Reel detected → counter reset.');
    // Returning to a Reel still sitting at end-of-play must start a new cycle (#3).
    if (state.autoScroll && isNearPlaybackEnd(state.activeVideo)) {
      prepareFreshPlayback(state.activeVideo);
    } else {
      state.videoEndedFired = false;
      state.pendingFreshStart = false;
    }
    if (state.progressBar) updateProgressBar(state.activeVideo);
    broadcastStatus();
  }

  function advanceToNext() {
    if (!state.autoScroll) return;
    if (state.advancing) return;
    if (isCommentsOpen()) {
      state.heldForComments = true;
      state.commentsOpen = true;
      log('Comments open — holding auto-advance.');
      broadcastStatus();
      return;
    }
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
      refreshActiveVideo({ resetCount: true, allowReelChange: true });
      // playCount hits repeatCount before advance; src keys may lag on the new Reel.
      resetPlayCount();
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

  function isElementVisible(el) {
    if (!el || !el.isConnected) return false;
    try {
      const r = el.getBoundingClientRect();
      if (r.width < 16 || r.height < 16) return false;
      const style = window.getComputedStyle(el);
      if (!style) return true;
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      if (parseFloat(style.opacity || '1') === 0) return false;
      return true;
    } catch (_e) {
      return false;
    }
  }

  function isCommentsDialog(dialog) {
    if (!dialog) return false;
    const label = (dialog.getAttribute && dialog.getAttribute('aria-label')) || '';
    if (/\bcomments?\b/i.test(label)) return true;
    const text = (dialog.innerText || '').trim();
    if (/^comments?\b/i.test(text)) return true;
    // Dialog with a Close control + "Comments" somewhere in the body.
    if (/\bcomments?\b/i.test(text) && dialog.querySelector('svg[aria-label*="Close" i], [aria-label="Close"]')) {
      return true;
    }
    return false;
  }

  /**
   * True when Instagram's Reels comments panel is open.
   * Prefer role="dialog" + Comments heading; fall back to expanded Comment
   * control or a visible compose field.
   */
  function isCommentsOpen() {
    try {
      const dialogs = document.querySelectorAll(COMMENT_DIALOG_SELECTOR);
      for (const dialog of dialogs) {
        if (isElementVisible(dialog) && isCommentsDialog(dialog)) return true;
      }
      if (document.querySelector(COMMENT_CONTROL_EXPANDED_SELECTOR)) return true;
      for (const sel of COMMENT_COMPOSE_SELECTORS) {
        const field = document.querySelector(sel);
        if (field && isElementVisible(field)) return true;
      }
    } catch (_e) {}
    return false;
  }

  function syncCommentsPanelState() {
    const open = isCommentsOpen();
    const wasOpen = state.commentsOpen;
    state.commentsOpen = open;
    if (wasOpen === open) return;

    if (open) {
      log('Comments panel opened — auto-advance will hold at end of play.');
      return;
    }

    log('Comments panel closed.');
    if (!state.heldForComments) return;
    state.heldForComments = false;
    // Do not jump immediately. Only restart if still sitting at EOF; if the
    // Reel already looped while comments were open, keep playing and advance
    // on the next natural ending.
    if (state.autoScroll && state.activeVideo) {
      if (isNearPlaybackEnd(state.activeVideo)) {
        log('Resuming auto-scroll after comments — restarting current Reel (EOF).');
        prepareFreshPlayback(state.activeVideo);
      } else {
        log('Resuming auto-scroll after comments — continuing current playback.');
        state.videoEndedFired = false;
        state.pendingFreshStart = false;
        if (state.progressBar) {
          updateProgressBar(state.activeVideo);
          if (!state.activeVideo.paused && !state.activeVideo.ended) {
            startProgressLoop();
          }
        }
      }
    } else {
      state.videoEndedFired = false;
    }
    broadcastStatus();
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
        refreshActiveVideo({ resetCount: true, allowReelChange: true });
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
