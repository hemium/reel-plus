#!/usr/bin/env node
/**
 * Launch Chrome with this unpacked extension loaded.
 * Chrome 137+ branded builds ignore --load-extension; use CDP Extensions.loadUnpacked.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import * as launcher from 'chrome-launcher';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(__dirname, '..');
const startUrl = process.argv[2] || 'chrome://extensions';

async function main() {
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
  });

  const pipes = chrome.remoteDebuggingPipes;
  if (!pipes) {
    throw new Error('Chrome did not expose remoteDebuggingPipes');
  }

  console.log('Chrome launched (remote-debugging-pipe).');
  console.log('Loading extension from:', extDir);

  const requestId = Math.floor(Math.random() * 1e6);
  const request = {
    id: requestId,
    method: 'Extensions.loadUnpacked',
    params: { path: extDir },
  };

  const firstResponse = new Promise((resolve, reject) => {
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
  });

  pipes.outgoing.write(JSON.stringify(request) + '\x00');

  const response = await firstResponse;
  if (response.error) {
    throw new Error(`Failed to load extension: ${JSON.stringify(response.error)}`);
  }

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
