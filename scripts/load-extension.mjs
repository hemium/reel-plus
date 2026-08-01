#!/usr/bin/env node
/**
 * Launch Chrome with this unpacked extension loaded.
 * Chrome 137+ branded builds ignore --load-extension; use CDP Extensions.loadUnpacked.
 */
import path from 'path';
import os from 'os';
import { existsSync, mkdirSync, renameSync } from 'fs';
import { fileURLToPath } from 'url';
import * as launcher from 'chrome-launcher';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(__dirname, '..');
// Keep the profile OUTSIDE the extension root — Chrome's unpacked "Size" is the
// whole folder, so a profile here used to report ~1GB for a tiny extension.
const legacyProfileDir = path.join(extDir, '.chrome-profile');
const defaultProfileDir = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'reels-plus-chrome-profile')
  : path.join(os.homedir(), '.reels-plus-chrome-profile');
const args = process.argv.slice(2);
const useMainProfile = args.includes('--main');
const startUrl = args.find((arg) => !arg.startsWith('--')) || 'chrome://extensions';
const profileDir = process.env.CHROME_USER_DATA_DIR || defaultProfileDir;

function migrateLegacyProfile(fromDir, toDir) {
  if (!existsSync(fromDir) || existsSync(toDir)) return;
  mkdirSync(path.dirname(toDir), { recursive: true });
  renameSync(fromDir, toDir);
  console.log('Moved Chrome profile out of the extension folder:');
  console.log(`  ${fromDir}`);
  console.log(`  → ${toDir}`);
}

async function launchMainProfileForManualInstall(url) {
  const { spawn } = await import('child_process');
  const chromePath = launcher.getChromePath();
  const chrome = spawn(chromePath, [url || 'chrome://extensions'], {
    detached: true,
    stdio: 'ignore',
  });
  chrome.unref();

  console.log('Opened your main Chrome profile.');
  console.log('Chrome blocks automated extension loading on the default profile.');
  console.log('');
  console.log('One-time install on chrome://extensions:');
  console.log('  1. Turn on Developer mode (top right)');
  console.log('  2. Click "Load unpacked"');
  console.log(`  3. Select: ${extDir}`);
  console.log('');
  console.log('After code changes, click the reload icon on the Reels+ card.');
}

async function loadUnpackedViaPipe(pipes, extensionPath) {
  const requestId = Math.floor(Math.random() * 1e6);
  const request = {
    id: requestId,
    method: 'Extensions.loadUnpacked',
    params: { path: extensionPath },
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
          // ignore non-JSON
        }
      }
    };
    pipes.incoming.on('error', reject);
    pipes.incoming.on('close', () => reject(new Error('Pipe closed before response')));
    pipes.incoming.on('data', onData);
    pipes.outgoing.write(JSON.stringify(request) + '\x00');
  });

  if (response.error) {
    throw new Error(`Failed to load extension: ${JSON.stringify(response.error)}`);
  }
  return response;
}

async function main() {
  if (useMainProfile) {
    await launchMainProfileForManualInstall(startUrl);
    return;
  }

  if (!profileDir) {
    throw new Error('Chrome profile path not found.');
  }
  if (!process.env.CHROME_USER_DATA_DIR) {
    migrateLegacyProfile(legacyProfileDir, profileDir);
  }
  mkdirSync(profileDir, { recursive: true });

  // chrome-launcher defaults include --mute-audio / --disable-extensions for
  // CI. Strip both so Reels actually have sound while we develop.
  const chromeFlags = launcher.Launcher.defaultFlags()
    .filter((flag) => flag !== '--disable-extensions' && flag !== '--mute-audio')
    .concat([
      '--remote-debugging-pipe',
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--no-default-browser-check',
    ]);

  const chrome = await launcher.launch({
    chromeFlags,
    ignoreDefaultFlags: true,
    startingUrl: startUrl,
    userDataDir: profileDir,
  });

  const pipes = chrome.remoteDebuggingPipes;
  if (!pipes) {
    throw new Error('Chrome did not expose remoteDebuggingPipes');
  }

  console.log('Chrome launched (remote-debugging-pipe).');
  console.log('Profile dir:', profileDir);
  console.log('Loading extension from:', extDir);

  const response = await loadUnpackedViaPipe(pipes, extDir);

  console.log('Extension loaded. id=', response.result?.id);
  console.log('Keep this terminal open while Chrome is running.');
  console.log('Open chrome://extensions — you should see "Reels+".');

  chrome.process.on('exit', (code) => {
    console.log('Chrome closed. exit=', code);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
