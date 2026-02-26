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
        return parseKeyboardDevicesFromProcEntry(raw);
    } catch {
        return [];
    }
}

function parseKeyboardDevicesFromProcEntry(raw: string): string[] {
    const devices: string[] = [];
    let currentHandlers = "";
    let isKeyboard = false;

    for (const line of raw.split("\n")) {
        if (line.startsWith("B: EV=")) {
            // EV bitmap — bit 1 = EV_KEY, bit 17 = EV_REP (key repeat = keyboard)
            const evBits = parseInt(line.split("=")[1], 16);
            isKeyboard = (evBits & 0x20002) === 0x20002;
        } else if (line.startsWith("H: Handlers=")) {
            currentHandlers = line;
        } else if (line.trim() === "" && isKeyboard && currentHandlers) {
            const match = currentHandlers.match(/event\d+/g);
            if (match) {
                for (const ev of match) devices.push(path.join("/dev/input", ev));
            }
            isKeyboard = false;
            currentHandlers = "";
        }
    }
    return devices;
}

interface EvdevEvent {
    type: number;
    code: number;
    value: number;
}

/** Parse one struct input_event from a 24-byte buffer slice. */
function parseEvdevEvent(buf: Buffer, offset: number): EvdevEvent {
    return {
        type: buf.readUInt16LE(offset + 16),
        code: buf.readUInt16LE(offset + 18),
        value: buf.readInt32LE(offset + 20),
    };
}

function dispatchEvdevEvent(event: EvdevEvent, getKey: () => string | null, getWin: () => BrowserWindow | null): void {
    if (event.type !== EV_KEY) return;

    const key = getKey();
    const win = getWin();
    if (!key || !win) return;

    const expectedCode = DOM_CODE_TO_EVDEV[key];
    if (expectedCode === undefined || event.code !== expectedCode) return;

    if (event.value === 1 || event.value === 2) {
        handleKeyDown(win);
    } else if (event.value === 0) {
        handleKeyUp(win);
    }
}

function createEvdevStreamForDevice(
    devPath: string,
    getKey: () => string | null,
    getWin: () => BrowserWindow | null,
): fs.ReadStream | null {
    try {
        // Verify readability synchronously before creating the stream.
        // fs.createReadStream defers open(), so errors only surface asynchronously.
        // fs.accessSync fails immediately if we lack read permission.
        fs.accessSync(devPath, fs.constants.R_OK);

        const stream = fs.createReadStream(devPath);
        let buf = Buffer.alloc(0);

        stream.on("data", (chunk: Buffer) => {
            buf = Buffer.concat([buf, chunk]);
            while (buf.length >= EVDEV_EVENT_SIZE) {
                dispatchEvdevEvent(parseEvdevEvent(buf, 0), getKey, getWin);
                buf = buf.subarray(EVDEV_EVENT_SIZE);
            }
        });

        stream.on("error", () => {
            // Device removed / closed after open — silently ignore
        });

        return stream;
    } catch {
        return null;
    }
}

/**
 * Open evdev streams for all keyboard devices. Returns a cleanup function.
 */
function setupEvdev(getKey: () => string | null, getWin: () => BrowserWindow | null): (() => void) | null {
    const devices = findKeyboardDevices();
    if (devices.length === 0) return null;

    const streams = devices
        .map((devPath) => createEvdevStreamForDevice(devPath, getKey, getWin))
        .filter((stream): stream is fs.ReadStream => stream !== null);

    if (streams.length === 0) return null;

    return () => {
        for (const stream of streams) stream.destroy();
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
        const accelerator = codeToAccelerator(key);
        const name = (UiohookKey as unknown as Record<number, string | undefined>)[keycode];
        return !!name && accelerator.toLowerCase() === name.toLowerCase();
    };

    uiohook.uIOhook.on("keydown", (event) => {
        const win = getWin();
        if (!win || !matchesKey(event.keycode)) return;
        handleKeyDown(win);
    });

    uiohook.uIOhook.on("keyup", (event) => {
        const win = getWin();
        if (!win || !matchesKey(event.keycode)) return;
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
// Backend selection
// ---------------------------------------------------------------------------

interface BackendState {
    ready: boolean;
    evdevCleanup: (() => void) | null;
}

function selectBackend(state: BackendState, key: string, getMainWindow: () => BrowserWindow | null): void {
    if (state.ready) return;

    state.evdevCleanup = setupEvdev(() => pttKey, getMainWindow);
    if (state.evdevCleanup) {
        console.log("PTT: using evdev backend");
        state.ready = true;
        return;
    }

    if (setupUiohook(() => pttKey, getMainWindow)) {
        console.log("PTT: using uiohook backend");
        state.ready = true;
        return;
    }

    console.warn("PTT: using globalShortcut fallback (focus-only)");
    const win = getMainWindow();
    if (win) setupGlobalShortcut(key, win);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function setupPTTIpc(getMainWindow: () => BrowserWindow | null): void {
    const backend: BackendState = { ready: false, evdevCleanup: null };

    ipcMain.on("ptt-register", (_event, key: string) => {
        const win = getMainWindow();
        if (!win) return;

        // Disable background throttling so IPC delivers promptly when unfocused.
        win.webContents.setBackgroundThrottling(false);

        pttKey = key;
        selectBackend(backend, key, getMainWindow);
    });

    ipcMain.on("ptt-unregister", () => {
        pttKey = null;
        isSpeaking = false;
        clearReleaseTimer();
        if (!backend.ready) globalShortcut.unregisterAll();

        // Re-enable throttling once PTT is no longer active.
        const win = getMainWindow();
        if (win) win.webContents.setBackgroundThrottling(true);
    });
}
