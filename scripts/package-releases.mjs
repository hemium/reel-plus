/**
 * Build two Chrome Web Store / GitHub release zips:
 *   - reels-plus-<version>-full.zip       (progress bar + auto-scroll)
 *   - reels-plus-<version>-progress.zip   (progress bar only)
 *
 * Usage: node scripts/package-releases.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const INCLUDE = [
  'manifest.json',
  'features.js',
  'background',
  'content',
  'popup',
  'icons',
];

const ICON_FILES = [
  'icon16.png',
  'icon32.png',
  'icon48.png',
  'icon128.png',
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyFile(src, dest) {
  mkdirp(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function copyTree(src, dest, filter) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    mkdirp(dest);
    for (const name of fs.readdirSync(src)) {
      if (filter && !filter(name, path.join(src, name))) continue;
      copyTree(path.join(src, name), path.join(dest, name), filter);
    }
    return;
  }
  copyFile(src, dest);
}

function writeFeatures(destRoot, autoScroll) {
  const body = `/*
 * Build feature flags. Packaged by scripts/package-releases.mjs
 */
var REELS_PLUS_FEATURES = {
  AUTO_SCROLL: ${autoScroll ? 'true' : 'false'},
};
`;
  fs.writeFileSync(path.join(destRoot, 'features.js'), body, 'utf8');
}

function stageVariant(outDir, { autoScroll, name, description }) {
  rmrf(outDir);
  mkdirp(outDir);

  for (const entry of INCLUDE) {
    const src = path.join(ROOT, entry);
    if (!fs.existsSync(src)) {
      throw new Error(`Missing required path: ${entry}`);
    }
    if (entry === 'icons') {
      mkdirp(path.join(outDir, 'icons'));
      for (const icon of ICON_FILES) {
        const iconSrc = path.join(src, icon);
        if (!fs.existsSync(iconSrc)) {
          throw new Error(`Missing icon: icons/${icon} (run node icons/generate-icons.js)`);
        }
        copyFile(iconSrc, path.join(outDir, 'icons', icon));
      }
      continue;
    }
    if (entry === 'features.js') continue; // written below
    copyTree(src, path.join(outDir, entry));
  }

  writeFeatures(outDir, autoScroll);

  const manifest = readJson(path.join(ROOT, 'manifest.json'));
  manifest.name = name;
  manifest.description = description;
  if (!autoScroll) {
    manifest.action = {
      ...manifest.action,
      default_title: name,
    };
  }
  fs.writeFileSync(
    path.join(outDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  );
}

function zipDirectory(srcDir, zipPath) {
  rmrf(zipPath);
  // Zip *contents* (not the parent folder) so Load unpacked / CWS expect root files.
  if (process.platform === 'win32') {
    const ps = `
$ErrorActionPreference = 'Stop'
$src = Join-Path (Resolve-Path '${srcDir.replace(/'/g, "''")}') '*'
Compress-Archive -Path $src -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force
`;
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', ps],
      { stdio: 'inherit' }
    );
  } else {
    execFileSync('zip', ['-r', '-q', zipPath, '.'], {
      cwd: srcDir,
      stdio: 'inherit',
    });
  }
}

function main() {
  const pkg = readJson(path.join(ROOT, 'package.json'));
  const version = pkg.version || readJson(path.join(ROOT, 'manifest.json')).version;
  mkdirp(DIST);

  const variants = [
    {
      id: 'full',
      autoScroll: true,
      name: 'Reels+',
      description:
        'Quality-of-life upgrades for Instagram web Reels: mobile-style progress bar and optional auto-advance. Private, no tracking.',
      zipName: `reels-plus-${version}-full.zip`,
    },
    {
      id: 'progress',
      autoScroll: false,
      name: 'Reels+ Progress',
      description:
        'Mobile-style progress bar for Instagram web Reels. Private, no tracking.',
      zipName: `reels-plus-${version}-progress.zip`,
    },
  ];

  const built = [];
  for (const v of variants) {
    const stage = path.join(DIST, v.id);
    console.log(`Staging ${v.id}…`);
    stageVariant(stage, v);
    const zipPath = path.join(DIST, v.zipName);
    console.log(`Zipping → ${v.zipName}`);
    zipDirectory(stage, zipPath);
    built.push(zipPath);
  }

  console.log('\nReady:');
  for (const p of built) console.log(`  ${p}`);
}

main();
