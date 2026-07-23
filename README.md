# Reels+

Quality-of-life upgrades for Instagram **web** Reels. One lightweight
Manifest V3 extension — not a grab-bag “Instagram Plus” for the whole site.

## Features (independent toggles)

- **Progress bar** — mobile/Stories-style playback bar on the active Reel.
- **Auto-scroll** — advance after a configurable number of full plays (1–20).

Private: no tracking, no network requests of its own.

## Why one extension (not two projects)

Both features need the same Reels video binding, SPA navigation handling, and
selector fallbacks. Splitting them means two installs fighting over the same
DOM. Keep one product; add features as toggles.

## Install (Developer Mode)

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. **Load unpacked** → this project folder  
   *(or run `npm run launch` / `npm run launch:reels` on Chrome 137+).*
4. Open `https://www.instagram.com/reels/` and flip the toggles you want.

## Releases

```bash
npm run package
```

Produces two installable zips in `dist/`:

| Zip | Contents |
|---|---|
| `reels-plus-<ver>-full.zip` | Progress bar + auto-scroll |
| `reels-plus-<ver>-progress.zip` | Progress bar only |

Load either via `chrome://extensions` → **Load unpacked** (unzip first) or attach to a GitHub Release.

## Project Structure

```
├── manifest.json
├── popup/
├── content/content.js
├── background/service-worker.js
├── icons/
├── scripts/load-extension.mjs
└── README.md
```

## Settings

| Key | Default | Meaning |
|---|---|---|
| `progressBar` | `true` | Show the on-Reel progress bar |
| `autoScroll` | `false` | Auto-advance after N plays |
| `repeatCount` | `1` | Plays before advance (auto-scroll only) |

Legacy `enabled` is migrated to `autoScroll` on install/update.

## Updating Selectors

If Instagram’s DOM shifts, edit the lists at the top of `content/content.js`:

- `VIDEO_SELECTORS`
- `NEXT_BUTTON_SELECTORS`
