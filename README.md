# Nexus Desktop

Nexus is a fork of [Element Desktop](https://github.com/element-hq/element-desktop) — an Electron wrapper for a Matrix client — with a built-in **Push-to-Talk (PTT)** voice channel system that works globally on Wayland, X11, and other platforms.

The webapp is provided by [element-ptt-web](https://github.com/r1gzee/element-ptt-web).

---

## PTT backends

Global key capture is tried in priority order at runtime when you join a voice channel:

| Priority | Backend | When it activates |
|----------|---------|-------------------|
| 1 | **evdev** | Linux; reads `/dev/input/event*` directly. Works on Wayland and X11. Requires the user to be in the `input` group. |
| 2 | **uiohook-napi** | X11 only fallback (installed as an optional dependency). |
| 3 | **globalShortcut** | Last resort; only fires when the Electron window is focused. |

Additionally, an HTTP server listens on `http://127.0.0.1:7700` at launch. This lets any window manager or script trigger PTT without needing global key capture:

```bash
curl -X POST http://127.0.0.1:7700/ptt/down   # key down
curl -X POST http://127.0.0.1:7700/ptt/up     # key up
```

This is the recommended approach for Wayland compositors (Sway, Hyprland, KDE, GNOME) that can bind arbitrary shell commands to keys.

### Wayland evdev setup

For the evdev backend to work, add your user to the `input` group and re-login:

```bash
sudo usermod -aG input $USER
# log out and back in, then verify:
groups   # should include 'input'
```

---

## Development

### Prerequisites

- Node 22+
- pnpm 10+

### Install

```bash
pnpm install
```

### Populate the webapp

The desktop app needs a built copy of the webapp from [element-ptt-web](https://github.com/r1gzee/element-ptt-web).

```bash
# Symlink for development (changes in element-web reflect immediately after rebuild)
ln -s ../element-web/apps/web/webapp webapp

# Or copy a built webapp
rm -rf webapp && cp -r ../element-web/apps/web/webapp webapp
```

### Run locally

```bash
pnpm start
```

This builds the TypeScript, copies resources, then launches Electron. Check the terminal output for the PTT backend that was selected:

```
PTT: using evdev backend       ← Wayland/Linux (best)
PTT: using uiohook backend     ← X11 fallback
PTT: using globalShortcut fallback (focus-only)
PTT: HTTP server listening on http://127.0.0.1:7700
```

---

## Building distributables

### CI (recommended)

Three `workflow_dispatch` workflows are available in `.github/workflows/`:

| Workflow | Runner | Output |
|----------|--------|--------|
| `build_nexus_linux.yaml` | `ubuntu-22.04` | `.AppImage`, `.deb` |
| `build_nexus_macos.yaml` | `macos-14` (M1, unsigned) | `.dmg` |
| `build_nexus_windows.yaml` | `windows-latest` (unsigned) | `.exe` |

Trigger from the **Actions** tab → select workflow → **Run workflow** on `develop`.

### Local (Linux)

```bash
VARIANT_PATH=element.io/nexus/build.json pnpm run build:ts && pnpm run build:res
pnpm run asar-webapp
VARIANT_PATH=element.io/nexus/build.json npx electron-builder --linux AppImage deb --publish never
# Output: dist/Nexus-<version>.AppImage, dist/nexus-desktop_<version>_amd64.deb
```

---

## Profiles

Run multiple instances for different accounts:

```bash
nexus-desktop --profile Work
```

Or specify a custom profile directory:

```bash
nexus-desktop --profile-dir /path/to/profile
```

---

## Copyright & License

Nexus is a fork of Element Desktop.

Copyright (c) 2016-2017 OpenMarket Ltd
Copyright (c) 2017 Vector Creations Ltd
Copyright (c) 2017-2025 New Vector Ltd

This software is multi-licensed under AGPL-3.0, GPL-3.0, or a commercial Element license. See [LICENSE files](LICENSE) for details.
