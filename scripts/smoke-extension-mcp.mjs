#!/usr/bin/env node
/**
 * Smoke test Reels+ using chrome-extension-tester-mcp tool handlers.
 * Run: node scripts/smoke-extension-mcp.mjs
 *
 * Note: run_assertion / take_screenshot open a fresh tab when the active page is
 * chrome-extension:// (MCP treats it as restricted). Use inspect_dom for popup checks.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HANDLERS } from '../node_modules/chrome-extension-tester-mcp/src/tools/index.js';
import { state } from '../node_modules/chrome-extension-tester-mcp/src/state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(__dirname, '..');

function text(result) {
  return result.content?.map((c) => c.text).join('\n') ?? JSON.stringify(result);
}

function pass(label, detail) {
  console.log(`PASS — ${label}`);
  if (detail) console.log(`       ${detail.replace(/\n/g, '\n       ')}`);
}

function fail(label, detail) {
  console.error(`FAIL — ${label}`);
  if (detail) console.error(`       ${detail.replace(/\n/g, '\n       ')}`);
  process.exitCode = 1;
}

async function run(name, args) {
  const handler = HANDLERS[name];
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  return handler(args);
}

async function main() {
  console.log('Reels+ smoke test (chrome-extension-tester-mcp)\n');
  console.log(`Extension path: ${extDir}\n`);

  const loaded = await run('load_extension', { extension_path: extDir });
  console.log(text(loaded));
  console.log('');

  if (!state.extensionId) {
    fail('Extension ID detected', 'No service worker / extension ID after load_extension');
    return;
  }
  pass('Extension ID detected', state.extensionId);

  const popupUrl = `chrome-extension://${state.extensionId}/popup/popup.html`;
  const popupCheck = await run('inspect_dom', {
    url: popupUrl,
    script: `({
      title: document.querySelector('h1')?.textContent?.trim(),
      hasProgressToggle: !!document.querySelector('#progressToggle'),
      hasAutoScrollToggle: !!document.querySelector('#autoScrollToggle'),
      tagline: document.querySelector('.tagline')?.textContent?.trim(),
    })`,
  });

  let popup;
  try {
    const body = text(popupCheck);
    const jsonStart = body.indexOf('{');
    popup = JSON.parse(body.slice(jsonStart));
  } catch (err) {
    fail('Popup DOM inspection', `${text(popupCheck)}\nParse error: ${err.message}`);
    return;
  }

  if (popup.title === 'Reels+') pass('Popup title is Reels+');
  else fail('Popup title is Reels+', `Got: ${JSON.stringify(popup.title)}`);

  if (popup.hasProgressToggle) pass('Progress bar toggle exists');
  else fail('Progress bar toggle exists');

  if (popup.hasAutoScrollToggle) pass('Auto-scroll toggle exists');
  else fail('Auto-scroll toggle exists');

  if (popup.tagline) pass('Popup tagline present', popup.tagline);

  const storage = await run('extension_storage', { action: 'get' });
  pass('Read chrome.storage.local', text(storage).split('\n').slice(1).join('\n').trim());

  const shotPath = path.join(extDir, 'dist', 'smoke-popup.png');
  await state.page.screenshot({ path: shotPath });
  pass('Popup screenshot saved', shotPath);

  console.log('\nDone.');
}

main()
  .catch((err) => {
    console.error('Smoke test error:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (state.browser) {
      await state.browser.close().catch(() => {});
    }
  });
