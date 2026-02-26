/*
Copyright 2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

/**
 * Push-to-Talk global key detection for Electron.
 *
 * Priority:
 *   1. Linux evdev  — reads /dev/input/event* directly; works on X11 and Wayland.
 *                     Requires the user to be in the `input` group.
 *   2. uiohook-napi — X11 XRecord; works on X11 only (fallback for non-Linux or
 *                     if evdev devices are not accessible).
 *   3. globalShortcut + key-repeat watchdog — last resort; only works when the
 *                     app window is focused on Wayland.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { globalShortcut, ipcMain, type BrowserWindow } from "electron";

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let pttKey: string | null = null;
let isSpeaking = false;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * How long (ms) after the last keydown before we consider the key released.
 * Must exceed the OS key-repeat interval (~33 ms at 30 repeats/s).
 */
const KEY_REPEAT_RELEASE_MS = 150;

function clearReleaseTimer(): void {
    if (releaseTimer) {
        clearTimeout(releaseTimer);
        releaseTimer = null;
    }
}

function handleKeyDown(win: BrowserWindow): void {
    clearReleaseTimer();
    if (!isSpeaking) {
        isSpeaking = true;
        win.webContents.send("ptt-keydown");
    }
    releaseTimer = setTimeout(() => handleKeyUp(win), KEY_REPEAT_RELEASE_MS);
}

function handleKeyUp(win: BrowserWindow): void {
    clearReleaseTimer();
    if (isSpeaking) {
        isSpeaking = false;
        win.webContents.send("ptt-keyup");
    }
}

// ---------------------------------------------------------------------------
// DOM-code → Linux evdev keycode mapping
// ---------------------------------------------------------------------------

const DOM_CODE_TO_EVDEV: Record<string, number> = {
    Space: 57,
    Enter: 28,
    Escape: 1,
    Tab: 15,
    Backspace: 14,
    Backquote: 41,
    Minus: 12,
    Equal: 13,
    BracketLeft: 26,
    BracketRight: 27,
    Backslash: 43,
    Semicolon: 39,
    Quote: 40,
    Comma: 51,
    Period: 52,
    Slash: 53,
    ShiftLeft: 42,
    ShiftRight: 54,
    ControlLeft: 29,
    ControlRight: 97,
    AltLeft: 56,
    AltRight: 100,
    MetaLeft: 125,
    MetaRight: 126,
    CapsLock: 58,
    KeyA: 30, KeyB: 48, KeyC: 46, KeyD: 32, KeyE: 18,
    KeyF: 33, KeyG: 34, KeyH: 35, KeyI: 23, KeyJ: 36,
    KeyK: 37, KeyL: 38, KeyM: 50, KeyN: 49, KeyO: 24,
    KeyP: 25, KeyQ: 16, KeyR: 19, KeyS: 31, KeyT: 20,
    KeyU: 22, KeyV: 47, KeyW: 17, KeyX: 45, KeyY: 21, KeyZ: 44,
    Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6,
    Digit6: 7, Digit7: 8, Digit8: 9, Digit9: 10, Digit0: 11,
    F1: 59, F2: 60, F3: 61, F4: 62, F5: 63,
    F6: 64, F7: 65, F8: 66, F9: 67, F10: 68, F11: 87, F12: 88,
};

// ---------------------------------------------------------------------------
// evdev backend
// ---------------------------------------------------------------------------

/** Size of struct input_event on 64-bit Linux: 8+8+2+2+4 = 24 bytes */
const EVDEV_EVENT_SIZE = 24;
const EV_KEY = 1;

/**
 * Find all keyboard event devices by inspecting /proc/bus/input/devices.
 * Returns paths like ["/dev/input/event3", ...].
 */
function findKeyboardDevices(): string[] {
    try {
        const raw = fs.readFileSync("/proc/bus/input/devices", "utf8");
        const devices: string[] = [];
        let currentHandlers = "";
        let isKeyboard = false;

        for (const line of raw.split("\n")) {
            if (line.startsWith("B: EV=")) {
                // EV bitmap — bit 1 = EV_KEY, bit 17 = EV_REP (key repeat = keyboard)
                const evBits = parseInt(line.split("=")[1], 16);
                isKeyboard = (evBits & 0x20002) === 0x20002; // has both EV_KEY and EV_REP
            } else if (line.startsWith("H: Handlers=")) {
                currentHandlers = line;
            } else if (line.trim() === "" && isKeyboard && currentHandlers) {
                const match = currentHandlers.match(/event\d+/g);
                if (match) {
                    for (const ev of match) {
                        devices.push(path.join("/dev/input", ev));
                    }
                }
                isKeyboard = false;
                currentHandlers = "";
            }
        }
        return devices;
    } catch {
        return [];
    }
}

/**
 * Open evdev streams for all keyboard devices. Returns a cleanup function.
 */
function setupEvdev(getKey: () => string | null, getWin: () => BrowserWindow | null): (() => void) | null {
    const devices = findKeyboardDevices();
    if (devices.length === 0) return null;

    const streams: fs.ReadStream[] = [];
    let anyOpened = false;

    for (const devPath of devices) {
        try {
            // Verify readability synchronously before creating the stream.
            // fs.createReadStream defers the open() call, so errors only surface
            // asynchronously — meaning anyOpened would be set even if the file
            // is not accessible.  fs.accessSync fails immediately if we lack
            // read permission (e.g. not in the `input` group).
            fs.accessSync(devPath, fs.constants.R_OK);

            const stream = fs.createReadStream(devPath);
            let buf = Buffer.alloc(0);

            stream.on("data", (chunk: Buffer) => {
                buf = Buffer.concat([buf, chunk]);
                while (buf.length >= EVDEV_EVENT_SIZE) {
                    const type = buf.readUInt16LE(16);
                    const code = buf.readUInt16LE(18);
                    const value = buf.readInt32LE(20);
                    buf = buf.subarray(EVDEV_EVENT_SIZE);

                    if (type !== EV_KEY) continue;

                    const key = getKey();
                    const win = getWin();
                    if (!key || !win) continue;

                    const expectedCode = DOM_CODE_TO_EVDEV[key];
                    if (expectedCode === undefined || code !== expectedCode) continue;

                    if (value === 1 || value === 2) {
                        // keydown or key-repeat
                        handleKeyDown(win);
                    } else if (value === 0) {
                        // keyup — exact, no watchdog needed
                        handleKeyUp(win);
                    }
                }
            });

            stream.on("error", () => {
                // Device removed / closed after open — silently ignore
            });

            streams.push(stream);
            anyOpened = true;
        } catch {
            // skip unreadable devices
        }
    }

    if (!anyOpened) return null;

    return () => {
        for (const s of streams) s.destroy();
    };
}

// ---------------------------------------------------------------------------
// uiohook-napi backend (X11 fallback)
// ---------------------------------------------------------------------------

function tryLoadUiohook(): typeof import("uiohook-napi") | null {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require("uiohook-napi") as typeof import("uiohook-napi");
    } catch {
        return null;
    }
}

function codeToAccelerator(code: string): string {
    const map: Record<string, string> = {
        Space: "Space", AltLeft: "Alt", AltRight: "Alt",
        ShiftLeft: "Shift", ShiftRight: "Shift",
        ControlLeft: "Control", ControlRight: "Control",
        MetaLeft: "Super", MetaRight: "Super",
        Backquote: "`", Minus: "-", Equal: "=",
        BracketLeft: "[", BracketRight: "]", Backslash: "\\",
        Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/",
    };
    if (map[code]) return map[code];
    if (code.startsWith("Key")) return code.slice(3);
    if (code.startsWith("Digit")) return code.slice(5);
    return code;
}

function setupUiohook(getKey: () => string | null, getWin: () => BrowserWindow | null): boolean {
    const uiohook = tryLoadUiohook();
    if (!uiohook) return false;

    const { UiohookKey } = uiohook;

    const matchesKey = (keycode: number): boolean => {
        const key = getKey();
        if (!key) return false;
        const acc = codeToAccelerator(key);
        const name = (UiohookKey as unknown as Record<number, string | undefined>)[keycode];
        return !!name && acc.toLowerCase() === name.toLowerCase();
    };

    uiohook.uIOhook.on("keydown", (e) => {
        const win = getWin();
        if (!win || !matchesKey(e.keycode)) return;
        handleKeyDown(win);
    });

    uiohook.uIOhook.on("keyup", (e) => {
        const win = getWin();
        if (!win || !matchesKey(e.keycode)) return;
        handleKeyUp(win);
    });

    try {
        uiohook.uIOhook.start();
        return true;
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// globalShortcut fallback (key-repeat watchdog; Wayland focus-only)
// ---------------------------------------------------------------------------

function setupGlobalShortcut(key: string, win: BrowserWindow): void {
    const accelerator = codeToAccelerator(key);
    globalShortcut.unregisterAll();
    const ok = globalShortcut.register(accelerator, () => handleKeyDown(win));
    if (!ok) console.warn(`PTT: failed to register global shortcut for "${accelerator}"`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function setupPTTIpc(getMainWindow: () => BrowserWindow | null): void {
    let backendReady = false;
    let evdevCleanup: (() => void) | null = null;

    ipcMain.on("ptt-register", (_event, key: string) => {
        const win = getMainWindow();
        if (!win) return;

        // Disable Chromium's background throttling so that webContents.send()
        // delivers IPC messages promptly even when the window is not focused.
        // Without this, global key events from evdev are silently delayed or
        // dropped when the renderer process is throttled.
        win.webContents.setBackgroundThrottling(false);

        pttKey = key;

        if (!backendReady) {
            // 1. Try evdev (Wayland + X11)
            evdevCleanup = setupEvdev(() => pttKey, getMainWindow);
            if (evdevCleanup) {
                console.log("PTT: using evdev backend");
                backendReady = true;
            }

            // 2. Try uiohook (X11 only)
            if (!backendReady && setupUiohook(() => pttKey, getMainWindow)) {
                console.log("PTT: using uiohook backend");
                backendReady = true;
            }

            // 3. globalShortcut fallback
            if (!backendReady) {
                console.warn("PTT: using globalShortcut fallback (focus-only)");
            }
        }

        if (!backendReady) {
            setupGlobalShortcut(key, win);
        }
    });

    ipcMain.on("ptt-unregister", () => {
        pttKey = null;
        isSpeaking = false;
        clearReleaseTimer();
        if (!backendReady) {
            globalShortcut.unregisterAll();
        }
        // Re-enable throttling once PTT is no longer active.
        const win = getMainWindow();
        if (win) win.webContents.setBackgroundThrottling(true);
    });
}
