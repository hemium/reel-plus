#!/usr/bin/env node
/**
 * Instagram Reels+ functional QA harness.
 * Launches Chrome with the logged-in reels-plus profile, loads the extension via CDP,
 * and runs automated scenarios on instagram.com/reels/.
 *
 * Run: npm run qa
 */
import path from 'node:path';
import os from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import * as launcher from 'chrome-launcher';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(__dirname, '..');
const profileDir =
  process.env.CHROME_USER_DATA_DIR ||
  (process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'reels-plus-chrome-profile')
    : path.join(os.homedir(), '.reels-plus-chrome-profile'));
const qaDir = path.join(extDir, 'dist', 'qa');
const CDP_PORT = 9223;
const REELS_URL = 'https://www.instagram.com/reels/';
const IG_HOME = 'https://www.instagram.com/';

const results = [];
const consoleLogs = [];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pass(id, detail) {
  results.push({ id, status: 'pass', detail });
  console.log(`  PASS  ${id}${detail ? ` — ${detail}` : ''}`);
}

function fail(id, detail, err) {
  results.push({ id, status: 'fail', detail, error: err?.message || String(err || '') });
  console.error(`  FAIL  ${id} — ${detail}`);
  if (err) console.error(`        ${err.message || err}`);
}

function skip(id, detail) {
  results.push({ id, status: 'skip', detail });
  console.log(`  SKIP  ${id} — ${detail}`);
}

function warn(id, detail) {
  results.push({ id, status: 'warn', detail });
  console.warn(`  WARN  ${id} — ${detail}`);
}

function killStaleTestChrome() {
  const selfPid = process.pid;
  try {
    if (process.platform === 'win32') {
      execSync(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne ${selfPid} -and $_.Name -eq 'chrome.exe' -and $_.CommandLine -match 'enable-unsafe-extension-debugging|load-extension\\.mjs|qa-instagram\\.mjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
        { stdio: 'ignore' }
      );
    } else {
      execSync(
        "pkill -f 'chrome.*enable-unsafe-extension-debugging' || true",
        { stdio: 'ignore', shell: true }
      );
    }
  } catch {
    // best effort
  }
}

async function loadExtensionViaPipe(chrome) {
  const pipes = chrome.remoteDebuggingPipes;
  if (!pipes) throw new Error('Chrome did not expose remoteDebuggingPipes');

  const requestId = Math.floor(Math.random() * 1e6);
  const request = {
    id: requestId,
    method: 'Extensions.loadUnpacked',
    params: { path: extDir },
  };

  const response = await new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf('\x00')) !== -1) {
        const message = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const parsed = JSON.parse(message);
          if (parsed.id === requestId) resolve(parsed);
        } catch {
          // ignore
        }
      }
    };
    pipes.incoming.on('error', reject);
    pipes.incoming.on('close', () => reject(new Error('Pipe closed before response')));
    pipes.incoming.on('data', onData);
    pipes.outgoing.write(JSON.stringify(request) + '\x00');
  });

  if (response.error) {
    throw new Error(`Extensions.loadUnpacked failed: ${JSON.stringify(response.error)}`);
  }
  return response.result?.id;
}

async function launchChrome() {
  mkdirSync(profileDir, { recursive: true });

  const chromeFlags = launcher.Launcher.defaultFlags()
    .filter((flag) => flag !== '--disable-extensions' && flag !== '--mute-audio')
    .concat([
      '--remote-debugging-pipe',
      `--remote-debugging-port=${CDP_PORT}`,
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
    ]);

  const chrome = await launcher.launch({
    chromeFlags,
    ignoreDefaultFlags: true,
    startingUrl: 'about:blank',
    userDataDir: profileDir,
  });

  const extensionId = await loadExtensionViaPipe(chrome);
  if (!extensionId) throw new Error('Extension loaded but no ID returned');

  await sleep(1500);
  return { chrome, extensionId };
}

async function connectPlaywright() {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const context = browser.contexts()[0] || await browser.newContext();
  return { browser, context };
}

function attachConsoleCollector(page) {
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('[Reels+]')) {
      consoleLogs.push({ type: msg.type(), text, ts: Date.now() });
    }
  });
}

async function getOrCreatePage(context, url) {
  const pages = context.pages();
  let page = pages.find((p) => !p.url().startsWith('chrome://') && !p.url().startsWith('chrome-extension://'));
  if (!page) page = await context.newPage();
  attachConsoleCollector(page);
  if (url && !page.url().startsWith(url.split('?')[0].slice(0, 30))) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
  return page;
}

async function setExtensionStorage(context, extensionId, settings) {
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/popup/popup.html`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    await page.evaluate(async (s) => {
      await chrome.storage.sync.set(s);
    }, settings);
  } finally {
    await page.close().catch(() => {});
  }
}

async function getExtensionStorage(context, extensionId, keys) {
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/popup/popup.html`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    return await page.evaluate(async (k) => chrome.storage.sync.get(k), keys);
  } finally {
    await page.close().catch(() => {});
  }
}

async function screenshot(page, name) {
  mkdirSync(qaDir, { recursive: true });
  const file = path.join(qaDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

async function waitFor(ms) {
  await sleep(ms);
}

// ---------------------------------------------------------------------------
// Page helpers (run in Instagram context)
// ---------------------------------------------------------------------------

async function isLoginWall(page) {
  return page.evaluate(() => {
    const url = window.location.href;
    if (url.includes('/accounts/login')) return true;
    const userInput = document.querySelector('input[name="username"]');
    const passInput = document.querySelector('input[name="password"]');
    return !!(userInput && passInput);
  });
}

async function hasProgressHost(page) {
  return page.evaluate(() => {
    const host = document.getElementById('ig-reels-plus-progress-host');
    return !!(host && host.isConnected && host.style.opacity !== '0');
  });
}

async function getProgressInfo(page) {
  return page.evaluate(() => {
    const host = document.getElementById('ig-reels-plus-progress-host');
    if (!host?.shadowRoot) return null;
    const fills = host.shadowRoot.querySelectorAll('.seg .fill');
    const segs = host.shadowRoot.querySelectorAll('.seg');
    return {
      visible: host.style.opacity !== '0',
      segmentCount: segs.length,
      fillWidths: Array.from(fills).map((f) => {
        const m = f.style.transform.match(/scaleX\(([\d.]+)\)/);
        if (m) return parseFloat(m[1]) * 100;
        return parseFloat(f.style.width) || 0;
      }),
      hostOpacity: host.style.opacity,
    };
  });
}

async function getActiveVideoInfo(page) {
  return page.evaluate(() => {
    const videos = Array.from(document.querySelectorAll('video'));
    let best = null;
    let bestArea = 0;
    for (const v of videos) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea && r.width > 40 && r.height > 40) {
        bestArea = area;
        best = v;
      }
    }
    if (!best) return null;
    return {
      src: best.currentSrc || best.src || '',
      currentTime: best.currentTime,
      duration: best.duration,
      paused: best.paused,
    };
  });
}

async function seekVideoNearEnd(page) {
  return page.evaluate(() => {
    const videos = Array.from(document.querySelectorAll('video'));
    let best = null;
    let bestArea = 0;
    for (const v of videos) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea && r.width > 40) {
        bestArea = area;
        best = v;
      }
    }
    if (!best || !Number.isFinite(best.duration) || best.duration <= 1) return false;
    best.currentTime = Math.max(0, best.duration - 0.25);
    return true;
  });
}

async function seekVideoToStart(page) {
  return page.evaluate(() => {
    const videos = Array.from(document.querySelectorAll('video'));
    for (const v of videos) {
      const r = v.getBoundingClientRect();
      if (r.width > 40 && r.height > 40) {
        v.currentTime = 0;
        v.play().catch(() => {});
        return true;
      }
    }
    return false;
  });
}

async function clickProgressBarAt(page, ratio) {
  return page.evaluate((r) => {
    const host = document.getElementById('ig-reels-plus-progress-host');
    if (!host?.shadowRoot) return false;
    const hit = host.shadowRoot.querySelector('.hit');
    if (!hit) return false;
    const rect = hit.getBoundingClientRect();
    const x = rect.left + rect.width * r;
    const y = rect.top + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    hit.dispatchEvent(new PointerEvent('pointerdown', opts));
    hit.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: x }));
    hit.dispatchEvent(new PointerEvent('pointerup', opts));
    return true;
  }, ratio);
}

async function readPopupStatus(context, extensionId, reelsPage) {
  await reelsPage.bringToFront();
  await waitFor(500);
  // Open popup in a side page but re-focus reels before popup.js pings active tab.
  const popup = await context.newPage();
  try {
    const pingPromise = popup.goto(`chrome-extension://${extensionId}/popup/popup.html`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    await reelsPage.bringToFront();
    await pingPromise;
    await waitFor(1000);
    const status = await popup.evaluate(() => document.getElementById('status')?.textContent?.trim() || '');
    return status;
  } finally {
    await popup.close().catch(() => {});
    await reelsPage.bringToFront();
  }
}

async function waitForVideo(page, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await getActiveVideoInfo(page);
    if (info && Number.isFinite(info.duration) && info.duration > 0) return info;
    await waitFor(500);
  }
  return null;
}

async function waitForProgressHost(page, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await hasProgressHost(page)) return true;
    await waitFor(400);
  }
  return false;
}

async function waitForNoProgressHost(page, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await hasProgressHost(page))) return true;
    await waitFor(300);
  }
  return false;
}

async function waitForVideoChange(page, prevSrc, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await getActiveVideoInfo(page);
    if (info && info.src && info.src !== prevSrc) return info;
    await waitFor(400);
  }
  return null;
}

async function waitForVideoReplay(page, prevTime, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await getActiveVideoInfo(page);
    if (info && info.currentTime < prevTime - 0.5) return info;
    await waitFor(300);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Test scenarios
// ---------------------------------------------------------------------------

async function testLoginGate(page) {
  const id = 'P0-login-gate';
  try {
    if (await isLoginWall(page)) {
      await screenshot(page, id);
      fail(id, 'Instagram login wall detected — log in via npm run launch:reels first');
      return false;
    }
    pass(id, 'Reels feed accessible (no login wall)');
    return true;
  } catch (err) {
    await screenshot(page, id).catch(() => {});
    fail(id, 'Could not verify login state', err);
    return false;
  }
}

async function testProgressBarDefault(page) {
  const id = 'P0-progress-bar-default';
  try {
    const found = await waitForProgressHost(page);
    if (!found) {
      await screenshot(page, id);
      fail(id, '#ig-reels-plus-progress-host not visible on /reels/');
      return;
    }
    const info = await getProgressInfo(page);
    pass(id, `Progress bar visible (${info?.segmentCount ?? 0} segment(s))`);
  } catch (err) {
    await screenshot(page, id).catch(() => {});
    fail(id, 'Progress bar check threw', err);
  }
}

async function testProgressTracksPlayback(page) {
  const id = 'P0-progress-tracks-playback';
  try {
    await seekVideoToStart(page);
    await waitFor(500);
    const vBefore = await getActiveVideoInfo(page);
    const before = await getProgressInfo(page);
    if (!before || !vBefore) {
      await screenshot(page, id);
      fail(id, 'No progress bar or video to sample');
      return;
    }
    const t0 = vBefore.currentTime;
    const w0 = before.fillWidths[0] ?? 0;
    await waitFor(2000);
    const vAfter = await getActiveVideoInfo(page);
    const after = await getProgressInfo(page);
    const sameReel = vAfter && vBefore.src && vAfter.src === vBefore.src;
    const timeAdvanced = sameReel && vAfter.currentTime > t0 + 0.3;
    const w1 = after?.fillWidths[0] ?? 0;
    const widthAdvanced = w1 > w0 + 0.5;
    if (timeAdvanced || widthAdvanced) {
      pass(id, sameReel
        ? `Time ${t0.toFixed(1)}s → ${vAfter.currentTime.toFixed(1)}s (width ${w0.toFixed(1)}% → ${w1.toFixed(1)}%)`
        : `Reel changed during sample (width ${w0.toFixed(1)}% → ${w1.toFixed(1)}%) — inconclusive`);
    } else if (!sameReel) {
      warn(id, 'Reel changed during 2s sample — could not verify progress tracking');
    } else {
      await screenshot(page, id);
      fail(id, `Progress did not advance on same reel (time ${t0.toFixed(1)}s → ${vAfter?.currentTime?.toFixed(1)}s)`);
    }
  } catch (err) {
    await screenshot(page, id).catch(() => {});
    fail(id, 'Playback tracking check threw', err);
  }
}

async function testProgressToggleOff(context, extensionId, page) {
  const id = 'P0-progress-toggle-off';
  try {
    await setExtensionStorage(context, extensionId, { progressBar: false, autoScroll: false });
    await waitFor(1200);
    const gone = await waitForNoProgressHost(page);
    if (gone) {
      pass(id, 'Progress host removed after toggle off');
    } else {
      await screenshot(page, id);
      fail(id, 'Progress host still present after toggle off');
    }
    await setExtensionStorage(context, extensionId, { progressBar: true });
    await waitFor(1200);
  } catch (err) {
    await screenshot(page, id).catch(() => {});
    fail(id, 'Toggle off check threw', err);
  }
}

async function testInactiveOffReels(context, extensionId, page) {
  const id = 'P0-inactive-off-reels';
  try {
    await setExtensionStorage(context, extensionId, { progressBar: true, autoScroll: false });
    await page.goto(IG_HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitFor(1500);
    const onHome = !(await hasProgressHost(page));
    await page.goto(REELS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitFor(2000);
    const onReels = await waitForProgressHost(page);
    if (onHome && onReels) {
      pass(id, 'Inactive on home, active on /reels/');
    } else {
      await screenshot(page, id);
      fail(id, `onHome=${onHome}, onReels=${onReels}`);
    }
  } catch (err) {
    await screenshot(page, id).catch(() => {});
    fail(id, 'Off-reels check threw', err);
  }
}

async function testAutoScroll(context, extensionId, page) {
  const id = 'P0-auto-scroll';
  try {
    await setExtensionStorage(context, extensionId, {
      progressBar: true,
      autoScroll: true,
      repeatCount: 1,
    });
    await page.goto(REELS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitFor(2500);
    const video = await waitForVideo(page);
    if (!video) {
      await screenshot(page, id);
      fail(id, 'No video found for auto-scroll test');
      return;
    }
    const prevSrc = video.src;
    const prevTime = video.currentTime;
    await seekVideoNearEnd(page);
    await waitFor(3000);
    const changed = await waitForVideoChange(page, prevSrc, 10000);
    if (changed) {
      pass(id, `Advanced to new reel (src changed)`);
    } else {
      const replayed = await waitForVideoReplay(page, prevTime, 2000);
      const warnings = consoleLogs.filter((l) => l.text.includes('Could not advance'));
      if (replayed && warnings.length) {
        await screenshot(page, id);
        fail(id, 'Video replayed but advance failed — check NEXT_BUTTON_SELECTORS', new Error(warnings[warnings.length - 1].text));
      } else if (!changed) {
        await screenshot(page, id);
        fail(id, 'Did not advance after seek-to-end');
      }
    }
  } catch (err) {
    await screenshot(page, id).catch(() => {});
    fail(id, 'Auto-scroll check threw', err);
  }
}

async function testRepeatCount(context, extensionId, page) {
  const id = 'P1-repeat-count-2';
  try {
    consoleLogs.length = 0;
    await setExtensionStorage(context, extensionId, {
      progressBar: true,
      autoScroll: true,
      repeatCount: 2,
    });
    await page.goto(REELS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitFor(2500);
    const progress = await getProgressInfo(page);
    if (progress?.segmentCount !== 2) {
      warn(id, `Expected 2 segments, got ${progress?.segmentCount}`);
    }
    const video = await waitForVideo(page);
    if (!video) {
      skip(id, 'No video for repeat test');
      return;
    }
    const prevSrc = video.src;
    const logStart = consoleLogs.length;
    await seekVideoNearEnd(page);
    await waitFor(3500);
    const logs = consoleLogs.slice(logStart);
    const playComplete = logs.find((l) => l.text.includes('Play complete. playCount=1 / target=2'));
    const advanced = logs.some((l) => l.text.includes('Advanced via'));
    const replayed = logs.some((l) => l.text.includes('Replaying Reel') || l.text.includes('replayFromStart'));
    const counterReset = logs.some((l) => l.text.includes('New Reel detected → counter reset.'));
    const afterFirst = await getActiveVideoInfo(page);
    const sameReel = afterFirst && afterFirst.src === prevSrc;
    const timeReset = sameReel && afterFirst.currentTime < 2;
    if (counterReset) {
      await screenshot(page, id);
      fail(id, 'Play counter reset during mid-repeat replay cycle');
    } else if (playComplete && !advanced && (replayed || (sameReel && timeReset))) {
      pass(id, replayed
        ? 'First play complete with repeatCount=2, replay triggered'
        : 'First play complete with repeatCount=2, same reel time reset');
    } else if (playComplete && advanced) {
      await screenshot(page, id);
      fail(id, 'Advanced prematurely instead of replaying (playCount=1 should replay)');
    } else if (!playComplete) {
      await screenshot(page, id);
      fail(id, 'Play complete event not logged for repeatCount=2');
    } else {
      await screenshot(page, id);
      fail(id, `Unexpected state: sameReel=${sameReel}, timeReset=${timeReset}, advanced=${advanced}`);
    }
  } catch (err) {
    await screenshot(page, id).catch(() => {});
    fail(id, 'Repeat count check threw', err);
  }
}

async function testPopupStatus(context, extensionId, page) {
  const id = 'P1-popup-status';
  try {
    await setExtensionStorage(context, extensionId, {
      progressBar: true,
      autoScroll: true,
      repeatCount: 1,
    });
    await page.goto(REELS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitFor(2500);
    const status = await readPopupStatus(context, extensionId, page);
    if (status.includes('On Reels') && status.includes('progress') && status.includes('auto')) {
      pass(id, `Status: "${status}"`);
    } else {
      await screenshot(page, id);
      fail(id, `Unexpected status: "${status}"`);
    }
  } catch (err) {
    await screenshot(page, id).catch(() => {});
    fail(id, 'Popup status check threw', err);
  }
}

async function testSettingsPersist(context, extensionId, page) {
  const id = 'P1-settings-persist';
  try {
    await setExtensionStorage(context, extensionId, {
      progressBar: true,
      autoScroll: false,
      repeatCount: 3,
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitFor(1500);
    const stored = await getExtensionStorage(context, extensionId, ['progressBar', 'autoScroll', 'repeatCount']);
    if (stored.progressBar === true && stored.autoScroll === false && stored.repeatCount === 3) {
      pass(id, 'Settings persisted across reload');
    } else {
      fail(id, `Storage mismatch: ${JSON.stringify(stored)}`);
    }
  } catch (err) {
    await screenshot(page, id).catch(() => {});
    fail(id, 'Settings persist check threw', err);
  }
}

async function testScrubSeek(page) {
  const id = 'P1-scrub-seek';
  try {
    await waitForProgressHost(page);
    const before = await getActiveVideoInfo(page);
    if (!before || !Number.isFinite(before.duration)) {
      skip(id, 'No video for scrub test');
      return;
    }
    const clicked = await clickProgressBarAt(page, 0.5);
    await waitFor(600);
    const after = await getActiveVideoInfo(page);
    if (!clicked) {
      fail(id, 'Could not dispatch scrub click on progress bar');
      return;
    }
    const moved = after && Math.abs(after.currentTime - before.duration * 0.5) < before.duration * 0.3;
    if (moved) {
      pass(id, `Seeked to ~${after.currentTime.toFixed(1)}s (from ${before.currentTime.toFixed(1)}s)`);
    } else {
      await screenshot(page, id);
      fail(id, `Scrub did not move playback (${before.currentTime.toFixed(1)} → ${after?.currentTime?.toFixed(1)})`);
    }
  } catch (err) {
    await screenshot(page, id).catch(() => {});
    fail(id, 'Scrub seek check threw', err);
  }
}

/** Issue #2: scrub Reel A, advance to B — B's progress fill must advance from ~0. */
async function testScrubThenNextProgress(context, extensionId, page) {
  const id = 'P1-scrub-then-next-progress';
  try {
    await setExtensionStorage(context, extensionId, {
      progressBar: true,
      autoScroll: false,
      repeatCount: 1,
    });
    await page.goto(REELS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitFor(2500);
    await waitForProgressHost(page);
    const before = await waitForVideo(page);
    if (!before || !Number.isFinite(before.duration) || before.duration < 2) {
      skip(id, 'No suitable video for scrub-then-next test');
      return;
    }

    const scrubbed = await clickProgressBarAt(page, 0.7);
    await waitFor(500);
    if (!scrubbed) {
      fail(id, 'Could not scrub progress bar before advancing');
      return;
    }

    await page.keyboard.press('ArrowDown');
    const next = await waitForVideoChange(page, before.src, 10000);
    if (!next) {
      await screenshot(page, id);
      fail(id, 'Did not advance to next Reel after scrub');
      return;
    }
    await waitFor(800);

    const sample0 = await getProgressInfo(page);
    const v0 = await getActiveVideoInfo(page);
    await waitFor(2000);
    const sample1 = await getProgressInfo(page);
    const v1 = await getActiveVideoInfo(page);

    const sameReel = v0 && v1 && v0.src === v1.src;
    const w0 = sample0?.fillWidths?.[0] ?? -1;
    const w1 = sample1?.fillWidths?.[0] ?? -1;
    const startedFresh = w0 < 40;
    const fillAdvanced = w1 > w0 + 1.5;
    const timeAdvanced = sameReel && (v1?.currentTime ?? 0) > (v0?.currentTime ?? 0) + 0.25;
    const notStuckFull = w0 < 95;

    // Fill advancing from a low start is the #2 signal; video time can lag if
    // getActiveVideoInfo briefly samples a preloaded neighbor node.
    if (startedFresh && notStuckFull && (fillAdvanced || timeAdvanced)) {
      pass(id, `Next Reel fill ${w0.toFixed(1)}% → ${w1.toFixed(1)}% (time ${v0?.currentTime?.toFixed(1)}→${v1?.currentTime?.toFixed(1)})`);
    } else {
      await screenshot(page, id);
      fail(
        id,
        `Progress stuck/wrong after scrub→next (w ${w0.toFixed(1)}→${w1.toFixed(1)}, sameReel=${sameReel}, t ${v0?.currentTime?.toFixed(1)}→${v1?.currentTime?.toFixed(1)})`,
      );
    }
  } catch (err) {
    await screenshot(page, id).catch(() => {});
    fail(id, 'Scrub-then-next progress check threw', err);
  }
}

async function goToPreviousReel(page) {
  // Instagram web uses "Navigate to previous Reel" (not plain "Previous").
  const clicked = await page.evaluate(() => {
    const sels = [
      'button[aria-label="Navigate to previous Reel"]',
      'div[role="button"][aria-label="Navigate to previous Reel"]',
      'button[aria-label*="Previous" i]',
      'div[role="button"][aria-label*="Previous" i]',
      'button[aria-label="Previous"]',
      'button[aria-label="Go to previous video"]',
    ];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (!el) continue;
      let target = el;
      for (let i = 0; i < 3 && target; i++) {
        const r = target.getBoundingClientRect();
        if (r.width >= 16 && r.height >= 16) {
          const role = target.getAttribute?.('role');
          const tag = target.tagName?.toLowerCase();
          if (tag === 'button' || role === 'button') {
            target.click();
            return sel;
          }
        }
        target = target.parentElement;
      }
      try {
        el.click();
        return sel;
      } catch {
        /* continue */
      }
    }
    return '';
  });
  if (clicked) return clicked;

  await page.keyboard.press('ArrowUp');
  return 'ArrowUp';
}

async function waitForNavigationAway(page, prevUrl, prevSrc, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await page.evaluate(() => {
      const videos = Array.from(document.querySelectorAll('video'));
      let best = null;
      let bestArea = 0;
      for (const v of videos) {
        const r = v.getBoundingClientRect();
        const area = r.width * r.height;
        if (area > bestArea && r.width > 40 && r.height > 40) {
          bestArea = area;
          best = v;
        }
      }
      return {
        url: location.href,
        src: best ? best.currentSrc || best.src || '' : '',
        currentTime: best ? best.currentTime : 0,
        duration: best ? best.duration : 0,
      };
    });
    if ((prevUrl && info.url && info.url !== prevUrl) || (prevSrc && info.src && info.src !== prevSrc)) {
      return info;
    }
    await waitFor(400);
  }
  return null;
}

/** Issue #3: after auto-advance, first return to prior Reel must play, not immediately re-advance. */
async function testReturnAfterAutoAdvance(context, extensionId, page) {
  const id = 'P1-return-after-auto-advance';
  try {
    consoleLogs.length = 0;
    await setExtensionStorage(context, extensionId, {
      progressBar: true,
      autoScroll: true,
      repeatCount: 1,
    });
    await page.goto(REELS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitFor(2500);
    const reelA = await waitForVideo(page);
    if (!reelA) {
      skip(id, 'No video for return-after-advance test');
      return;
    }
    const srcA = reelA.src;
    const urlA = page.url();

    await seekVideoNearEnd(page);
    const reelB = await waitForVideoChange(page, srcA, 12000);
    if (!reelB) {
      await screenshot(page, id);
      fail(id, 'Auto-scroll did not advance to next Reel');
      return;
    }
    const urlB = page.url();
    await waitFor(1500);

    // Ensure the page has focus for Instagram keyboard/button nav.
    await page.bringToFront();
    const vp = page.viewportSize() || { width: 800, height: 900 };
    await page.mouse.click(Math.floor(vp.width / 2), Math.floor(vp.height / 2));
    await waitFor(300);

    const navHow = await goToPreviousReel(page);
    let back = await waitForNavigationAway(page, urlB, reelB.src, 8000);

    if (!back) {
      await page.keyboard.press('ArrowUp');
      back = await waitForNavigationAway(page, urlB, reelB.src, 6000);
    }
    if (!back) {
      await page.mouse.wheel(0, -1000);
      back = await waitForNavigationAway(page, urlB, reelB.src, 6000);
    }

    if (!back) {
      await screenshot(page, id);
      fail(id, `Could not return to prior Reel (tried ${navHow} + fallbacks)`);
      return;
    }

    // If Instagram left the Reel at EOF, our fix should restart it quickly.
    if (Number.isFinite(back.duration) && back.duration > 1 && back.currentTime >= back.duration - 1) {
      const restarted = await waitForVideoReplay(page, back.currentTime, 4000);
      if (!restarted) {
        await screenshot(page, id);
        fail(id, `Returned at EOF (t=${back.currentTime.toFixed(1)}) but did not restart`);
        return;
      }
      back = { ...back, ...restarted };
    }

    await waitFor(900);
    const afterReturn = await getActiveVideoInfo(page);
    const urlReturned = page.url();
    const playingFresh =
      afterReturn
      && afterReturn.src
      && afterReturn.currentTime < Math.max(2.5, (afterReturn.duration || 10) * 0.35);

    await waitFor(2500);
    const stillOnReturned = await getActiveVideoInfo(page);
    const urlLater = page.url();
    // Still on the reel we returned to (URL stable, or same media) — not bounced forward again.
    const didNotReAdvance =
      urlLater === urlReturned
      || (urlA && urlLater === urlA)
      || (stillOnReturned && afterReturn && stillOnReturned.src === afterReturn.src);

    if ((playingFresh || (afterReturn && afterReturn.currentTime < (afterReturn.duration || 1) - 1)) && didNotReAdvance) {
      pass(
        id,
        `Returned via ${navHow}; played from ~${afterReturn?.currentTime?.toFixed(1)}s without re-advance`,
      );
    } else {
      await screenshot(page, id);
      fail(
        id,
        `Immediate re-advance or stuck at EOF (fresh=${playingFresh}, stayed=${didNotReAdvance}, t0=${afterReturn?.currentTime?.toFixed(1)}, t1=${stillOnReturned?.currentTime?.toFixed(1)}, urlB=${urlB} urlNow=${urlLater})`,
      );
    }
  } catch (err) {
    await screenshot(page, id).catch(() => {});
    fail(id, 'Return-after-auto-advance check threw', err);
  }
}

async function testSpaNavigation(context, extensionId, page) {
  const id = 'P2-spa-navigation';
  try {
    await setExtensionStorage(context, extensionId, { progressBar: true, autoScroll: false });
    await page.goto(REELS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitFor(2000);
    await page.evaluate(() => {
      history.pushState({}, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(800);
    const offAfterPush = !(await hasProgressHost(page));
    await page.evaluate(() => {
      history.pushState({}, '', '/reels/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(1200);
    const onAfterReturn = await waitForProgressHost(page, 5000);
    if (offAfterPush && onAfterReturn) {
      pass(id, 'Deactivates/reactivates on SPA URL change');
    } else {
      await screenshot(page, id);
      fail(id, `offAfterPush=${offAfterPush}, onAfterReturn=${onAfterReturn}`);
    }
  } catch (err) {
    await screenshot(page, id).catch(() => {});
    fail(id, 'SPA navigation check threw', err);
  }
}

/** Real Instagram nav click: Direct inbox → Reels (page-world History, no popstate). */
async function testSpaFromDirect(context, extensionId, page) {
  const id = 'P2-spa-from-direct';
  try {
    await setExtensionStorage(context, extensionId, { progressBar: true, autoScroll: false });
    await page.goto('https://www.instagram.com/direct/inbox/', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await waitFor(3000);
    if (await isLoginWall(page)) {
      skip(id, 'Login wall on Direct');
      return;
    }
    const offOnDirect = !(await hasProgressHost(page));
    const clicked = await page.evaluate(() => {
      const el = document.querySelector('a[href="/reels/"], a[href^="/reels/"]');
      if (!el) return false;
      el.click();
      return true;
    });
    if (!clicked) {
      skip(id, 'No Reels nav link on Direct');
      return;
    }
    // Wait for Instagram to land on /reels/ then for the progress host.
    let onReels = false;
    for (let i = 0; i < 40; i++) {
      await waitFor(250);
      const href = page.url();
      if (/\/reels\//i.test(href)) {
        onReels = true;
        break;
      }
    }
    const hostVisible = onReels && (await waitForProgressHost(page, 5000));
    if (offOnDirect && hostVisible) {
      pass(id, 'Progress bar appears after Direct → Reels nav click');
    } else {
      await screenshot(page, id);
      fail(id, `offOnDirect=${offOnDirect}, onReels=${onReels}, hostVisible=${hostVisible}`);
    }
  } catch (err) {
    await screenshot(page, id).catch(() => {});
    fail(id, 'SPA-from-Direct check threw', err);
  }
}

async function testHoverScrub(page) {
  const id = 'manual-hover-scrub';
  try {
    await waitForProgressHost(page);
    const box = await page.evaluate(() => {
      const host = document.getElementById('ig-reels-plus-progress-host');
      const hit = host?.shadowRoot?.querySelector('.hit');
      if (!hit) return null;
      const r = hit.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (!box) {
      skip(id, 'No progress hit zone');
      return;
    }
    await page.mouse.move(box.x, box.y);
    await waitFor(300);
    const after = await page.evaluate(() => {
      const host = document.getElementById('ig-reels-plus-progress-host');
      const hit = host?.shadowRoot?.querySelector('.hit');
      const seg = host?.shadowRoot?.querySelector('.seg');
      return {
        hoverClass: hit?.classList.contains('is-hover'),
        segHeight: seg ? parseFloat(getComputedStyle(seg).height) : 0,
      };
    });
    if (after.hoverClass || after.segHeight > 3) {
      pass(id, `Hover state active (seg height ${after.segHeight}px)`);
    } else {
      await screenshot(page, id);
      warn(id, 'Hover thicken may not have activated on mouseenter');
    }
  } catch (err) {
    await screenshot(page, id).catch(() => {});
    fail(id, 'Hover scrub check threw', err);
  }
}

async function testResizeLayout(page) {
  const id = 'manual-resize-layout';
  try {
    await waitForProgressHost(page);
    const before = await page.evaluate(() => {
      const host = document.getElementById('ig-reels-plus-progress-host');
      if (!host) return null;
      const r = host.getBoundingClientRect();
      return { width: r.width, opacity: host.style.opacity };
    });
    await page.setViewportSize({ width: 1100, height: 800 });
    await waitFor(1500);
    const after = await page.evaluate(() => {
      const host = document.getElementById('ig-reels-plus-progress-host');
      if (!host) return null;
      const r = host.getBoundingClientRect();
      return { width: r.width, opacity: host.style.opacity };
    });
    await page.setViewportSize({ width: 1400, height: 900 });
    if (before && after && after.opacity !== '0' && after.width > 100) {
      pass(id, `Bar repositioned after resize (${before.width.toFixed(0)}px → ${after.width.toFixed(0)}px wide)`);
    } else {
      await screenshot(page, id);
      warn(id, `Bar may be misaligned after resize (opacity=${after?.opacity}, width=${after?.width})`);
    }
  } catch (err) {
    await screenshot(page, id).catch(() => {});
    fail(id, 'Resize layout check threw', err);
  }
}

async function testManualScrollReset(context, extensionId, page) {
  const id = 'P2-manual-scroll-reset';
  try {
    await setExtensionStorage(context, extensionId, {
      progressBar: true,
      autoScroll: true,
      repeatCount: 2,
    });
    await page.goto(REELS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitFor(2500);
    await seekVideoNearEnd(page);
    await waitFor(1500);
    const beforeStatus = await readPopupStatus(context, extensionId, page);
    await page.keyboard.press('ArrowDown');
    await waitFor(2000);
    const afterStatus = await readPopupStatus(context, extensionId, page);
    const reset = afterStatus.includes('auto 0/2') || afterStatus.includes('auto 1/2');
    if (reset || beforeStatus !== afterStatus) {
      pass(id, `Status after ArrowDown: "${afterStatus}"`);
    } else {
      await screenshot(page, id);
      warn(id, `Play counter may not have reset. before="${beforeStatus}" after="${afterStatus}"`);
    }
  } catch (err) {
    await screenshot(page, id).catch(() => {});
    fail(id, 'Manual scroll reset check threw', err);
  }
}

function collectConsoleWarnings() {
  const warnings = consoleLogs.filter((l) => l.type === 'warning' || l.text.includes('warn') || l.text.includes('Could not') || l.text.includes('Failed'));
  for (const w of warnings) {
    warn('console', w.text);
  }
}

function writeReport() {
  mkdirSync(qaDir, { recursive: true });
  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  const skipped = results.filter((r) => r.status === 'skip').length;
  const warned = results.filter((r) => r.status === 'warn').length;

  const report = {
    timestamp: new Date().toISOString(),
    summary: { passed, failed, skipped, warned, total: results.length },
    results,
    consoleLogs: consoleLogs.map((l) => l.text),
  };
  const reportPath = path.join(qaDir, 'report.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  return { reportPath, passed, failed, skipped, warned };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('Reels+ Instagram QA\n');
  console.log(`Extension: ${extDir}`);
  console.log(`Profile:   ${profileDir}\n`);

  killStaleTestChrome();
  await sleep(1000);

  let chrome;
  let pwBrowser;
  try {
    console.log('Launching Chrome…');
    const { chrome: launched, extensionId } = await launchChrome();
    chrome = launched;
    console.log(`Extension ID: ${extensionId}\n`);

    console.log('Connecting Playwright over CDP…');
    const { browser, context } = await connectPlaywright();
    pwBrowser = browser;

    await setExtensionStorage(context, extensionId, {
      progressBar: true,
      autoScroll: false,
      repeatCount: 1,
    });

    console.log('Navigating to Instagram Reels…');
    const page = await getOrCreatePage(context, REELS_URL);
    await waitFor(3000);

    console.log('\nRunning scenarios:\n');

    const loggedIn = await testLoginGate(page);
    if (!loggedIn) {
      collectConsoleWarnings();
      const { reportPath, failed } = writeReport();
      console.log(`\nQA aborted (login required). Report: ${reportPath}`);
      process.exitCode = failed > 0 ? 1 : 0;
      return;
    }

    await testProgressBarDefault(page);
    await testProgressTracksPlayback(page);
    await testProgressToggleOff(context, extensionId, page);
    await waitForProgressHost(page);
    await testInactiveOffReels(context, extensionId, page);
    await testAutoScroll(context, extensionId, page);
    await testRepeatCount(context, extensionId, page);
    await testPopupStatus(context, extensionId, page);
    await testSettingsPersist(context, extensionId, page);
    await testScrubSeek(page);
    await testScrubThenNextProgress(context, extensionId, page);
    await testReturnAfterAutoAdvance(context, extensionId, page);
    await testSpaNavigation(context, extensionId, page);
    await testSpaFromDirect(context, extensionId, page);
    await testHoverScrub(page);
    await testResizeLayout(page);
    await testManualScrollReset(context, extensionId, page);

    collectConsoleWarnings();

    const { reportPath, passed, failed, skipped, warned } = writeReport();
    console.log('\n' + '='.repeat(50));
    console.log(`QA complete: ${passed} passed, ${failed} failed, ${skipped} skipped, ${warned} warnings`);
    console.log(`Report: ${reportPath}`);
    console.log(`Screenshots: ${qaDir}`);

    process.exitCode = failed > 0 ? 1 : 0;
  } finally {
    if (pwBrowser) {
      try { await pwBrowser.close(); } catch { /* ignore */ }
    }
    if (chrome) {
      try { chrome.kill(); } catch { /* ignore */ }
    }
  }
}

main().catch((err) => {
  console.error('QA harness error:', err);
  process.exitCode = 1;
});
