/*
Copyright 2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

/**
 * Push-to-Talk global shortcut support for Electron.
 *
 * Registers a system-level shortcut (via Electron's globalShortcut) that fires
 * even when the app is minimised or in the background, and sends IPC events to
 * the renderer so that usePTT.ts can start/stop speaking.
 *
 * Key-up detection: Electron's globalShortcut only fires on keydown. We use
 * `uiohook-napi` (optional native module) for OS-level keyup events. If that
 * module is unavailable at runtime we fall back to a 500 ms auto-release timer,
 * which gives a degraded but functional experience.
 *
 * Usage:
 *   Call `setupPTTIpc()` once after the app is ready.
 *   The renderer sends `ptt-register` / `ptt-unregister` IPC messages to
 *   control when the global shortcut is active.
 */

import { globalShortcut, ipcMain, type BrowserWindow } from "electron";

/** Timeout (ms) used as keyup fallback when uiohook-napi is not available. */
const PTT_AUTO_RELEASE_MS = 500;

let pttKey: string | null = null;
let autoReleaseTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Attempt to load uiohook-napi. Returns the module if available, null otherwise.
 * We use a dynamic require so a missing native module doesn't crash startup.
 */
function tryLoadUiohook(): typeof import("uiohook-napi") | null {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require("uiohook-napi") as typeof import("uiohook-napi");
    } catch {
        return null;
    }
}

/**
 * Convert an Electron/DOM KeyboardEvent `code` string (e.g. "Space", "AltLeft")
 * to an Electron `globalShortcut` accelerator string (e.g. "Space", "Alt").
 *
 * See https://www.electronjs.org/docs/latest/api/accelerator
 */
function codeToAccelerator(code: string): string {
    const map: Record<string, string> = {
        Space: "Space",
        AltLeft: "Alt",
        AltRight: "Alt",
        ShiftLeft: "Shift",
        ShiftRight: "Shift",
        ControlLeft: "Control",
        ControlRight: "Control",
        MetaLeft: "Super",
        MetaRight: "Super",
    };
    if (map[code]) return map[code];
    // KeyA -> A, Digit1 -> 1, F1 -> F1, etc.
    if (code.startsWith("Key")) return code.slice(3);
    if (code.startsWith("Digit")) return code.slice(5);
    return code;
}

/**
 * Registers the PTT global shortcut and wires up uiohook-napi (or fallback)
 * for keyup detection. Sends `ptt-keydown` and `ptt-keyup` IPC to the renderer.
 */
function registerPTTShortcut(key: string, win: BrowserWindow): void {
    const accelerator = codeToAccelerator(key);

    globalShortcut.unregisterAll();
    if (autoReleaseTimer) {
        clearTimeout(autoReleaseTimer);
        autoReleaseTimer = null;
    }

    const registered = globalShortcut.register(accelerator, () => {
        win.webContents.send("ptt-keydown");

        // Attempt keyup via uiohook-napi
        const uiohook = tryLoadUiohook();
        if (uiohook) {
            // uiohook-napi keyup is handled in the hook listener set up once below.
        } else {
            // Fallback: auto-release after fixed timeout
            if (autoReleaseTimer) clearTimeout(autoReleaseTimer);
            autoReleaseTimer = setTimeout(() => {
                win.webContents.send("ptt-keyup");
                autoReleaseTimer = null;
            }, PTT_AUTO_RELEASE_MS);
        }
    });

    if (!registered) {
        console.warn(`PTT: failed to register global shortcut for accelerator "${accelerator}" (key: ${key})`);
    }
}

/**
 * Set up uiohook-napi keyboard hook for keyup detection.
 * This runs once regardless of how many times the PTT key changes.
 */
function setupUiohookKeyup(key: () => string | null, win: BrowserWindow): void {
    const uiohook = tryLoadUiohook();
    if (!uiohook) return;

    const { UiohookKey } = uiohook;

    uiohook.uIOhook.on("keyup", (e) => {
        const currentKey = key();
        if (!currentKey) return;
        // Map DOM code to uiohook keycode — best-effort for common keys.
        // A full mapping would be a dedicated lookup table.
        const acc = codeToAccelerator(currentKey);
        const pressedName = UiohookKey[e.keycode];
        if (pressedName && acc.toLowerCase() === pressedName.toLowerCase()) {
            win.webContents.send("ptt-keyup");
        }
    });

    uiohook.uIOhook.start();
}

/**
 * Call once after `app.whenReady()`. Listens for IPC messages from the renderer
 * to register/unregister the PTT global shortcut.
 */
export function setupPTTIpc(getMainWindow: () => BrowserWindow | null): void {
    // Wire up uiohook once (it runs in the background, low overhead)
    // We defer because the window might not exist yet at module load time.
    let uiohookSetUp = false;

    ipcMain.on("ptt-register", (_event, key: string) => {
        const win = getMainWindow();
        if (!win) return;

        pttKey = key;
        registerPTTShortcut(key, win);

        if (!uiohookSetUp) {
            setupUiohookKeyup(() => pttKey, win);
            uiohookSetUp = true;
        }
    });

    ipcMain.on("ptt-unregister", () => {
        pttKey = null;
        globalShortcut.unregisterAll();
        if (autoReleaseTimer) {
            clearTimeout(autoReleaseTimer);
            autoReleaseTimer = null;
        }
    });
}
