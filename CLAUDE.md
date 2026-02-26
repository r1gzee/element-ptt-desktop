# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A fork of Element Desktop (Electron wrapper) rebranded as **Nexus**, with a multi-backend global PTT key listener that works on Wayland. It wraps the element-ptt-web webapp (`r1gzee/element-ptt-web`, the element-web fork).

## Commands

```bash
# Install
pnpm install

# Run locally (requires webapp/ to be populated — see below)
pnpm start          # builds TS + resources, then: electron .

# Type-check only
pnpm lint:types:src

# Populate webapp from the element-web fork before running/building
rm -rf webapp && cp -r ../element-web/apps/web/webapp webapp
# or symlink for development:
ln -s ../element-web/apps/web/webapp webapp

# Production build (AppImage + deb on Linux)
VARIANT_PATH=element.io/nexus/build.json pnpm run build:ts && pnpm run build:res
pnpm run asar-webapp
VARIANT_PATH=element.io/nexus/build.json npx electron-builder --linux AppImage deb --publish never

# Output: dist/Nexus-<version>.AppImage, dist/nexus-desktop_<version>_amd64.deb
```

## Build variant

The Nexus branding (appId `app.nexus.desktop`, productName `Nexus`) is configured in `element.io/nexus/build.json`. Always pass `VARIANT_PATH=element.io/nexus/build.json` to `electron-builder` or the default "Element" branding will be used.

## PTT architecture

Global key capture works across three backends tried in priority order, selected at runtime when the renderer sends `ptt-register`:

| Backend | File | When it activates |
|---------|------|-------------------|
| evdev | `src/ptt.ts` | Linux; user must be in the `input` group |
| uiohook-napi | `src/ptt.ts` | X11 only fallback (installed as optional dep) |
| globalShortcut | `src/ptt.ts` | Last resort; only fires when window has focus |

Additionally, `src/ptt-http-server.ts` starts an HTTP server on `127.0.0.1:7700` at launch. This lets any window manager trigger PTT via `curl -X POST http://127.0.0.1:7700/ptt/down` — the recommended approach for Wayland compositors (Sway, Hyprland, KDE, GNOME).

### IPC channels

- `ptt-register` (renderer→main): start listening for the given DOM key code
- `ptt-unregister` (renderer→main): stop listening, re-enable background throttling
- `ptt-keydown` / `ptt-keyup` (main→renderer): sent to webContents when key state changes

Background throttling is disabled (`webContents.setBackgroundThrottling(false)`) while PTT is registered so IPC arrives promptly when the window is not focused.

## Wayland note

For the evdev backend to work, the user must be in the `input` group:
```bash
sudo usermod -aG input $USER   # then log out/in
```

## Code style

- **Single-purpose functions**: each function does one thing. Split before it grows.
- **No deep nesting**: flatten with early returns and extracted helpers instead of nested `if`/callbacks.
- **Explicit over clever**: choose the readable solution, not the concise one.
- **Name for intent**: `isFloorOccupied`, `startSpeaking` — not `flag`, `fn`, `data`.
- **Flag functions over ~20 lines**: call it out before writing more; break it up first.
- **No workaround stacking**: when something doesn't work, break the problem down and fix the root cause. Don't patch over errors with try/catch or conditionals that hide the real issue.

## CI workflows

Three `workflow_dispatch` workflows in `.github/workflows/`:

| File | Runner | Output |
|------|--------|--------|
| `build_nexus_linux.yaml` | `ubuntu-22.04` | `.AppImage`, `.deb` |
| `build_nexus_macos.yaml` | `macos-14` (M1, unsigned) | `.dmg` |
| `build_nexus_windows.yaml` | `windows-latest` (unsigned) | `.exe` |

All workflows check out both this repo and `r1gzee/element-ptt-web`, build the webapp, copy it into `webapp/`, then run electron-builder with `VARIANT_PATH=element.io/nexus/build.json`.
