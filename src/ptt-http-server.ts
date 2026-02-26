/*
Copyright 2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

/**
 * Local HTTP server that accepts PTT trigger commands from the system.
 *
 * This is the most reliable cross-platform global PTT mechanism:
 *   - Linux/Wayland: bind a key in Sway, Hyprland, KDE, GNOME, etc.
 *   - Linux/X11:     same, or use the evdev/uiohook backends in ptt.ts
 *   - macOS:         bind via Automator, BetterTouchTool, or a shell script
 *   - Windows:       bind via AutoHotkey or Windows Task Scheduler
 *
 * Endpoints (all bound to 127.0.0.1 only):
 *   POST http://127.0.0.1:7700/ptt/down  — key pressed
 *   POST http://127.0.0.1:7700/ptt/up    — key released
 *
 * Example window manager configurations
 * ─────────────────────────────────────
 * Sway / i3:
 *   bindsym --no-repeat grave exec curl -sf -X POST http://127.0.0.1:7700/ptt/down
 *   bindsym --release    grave exec curl -sf -X POST http://127.0.0.1:7700/ptt/up
 *
 * Hyprland:
 *   bind  = , grave, exec, curl -sf -X POST http://127.0.0.1:7700/ptt/down
 *   bindr = , grave, exec, curl -sf -X POST http://127.0.0.1:7700/ptt/up
 *
 * KDE (via custom shortcut scripts):
 *   Key-press action:   curl -sf -X POST http://127.0.0.1:7700/ptt/down
 *   Key-release action: curl -sf -X POST http://127.0.0.1:7700/ptt/up
 *
 * macOS (shell script bound in System Settings → Keyboard Shortcuts):
 *   curl -sf -X POST http://127.0.0.1:7700/ptt/down   (on key down)
 *   curl -sf -X POST http://127.0.0.1:7700/ptt/up     (on key up)
 *
 * Windows (AutoHotkey v2):
 *   ``:: {
 *     Loop {
 *       if !GetKeyState("``", "P") {
 *         Run "curl -sf -X POST http://127.0.0.1:7700/ptt/up", , "Hide"
 *         break
 *       }
 *       if A_Index = 1
 *         Run "curl -sf -X POST http://127.0.0.1:7700/ptt/down", , "Hide"
 *       Sleep 50
 *     }
 *   }
 */

import * as http from "node:http";
import type { BrowserWindow } from "electron";

export const PTT_HTTP_PORT = 7700;

/**
 * Start the PTT HTTP server. Returns a cleanup function that closes the server.
 * The server is bound to 127.0.0.1 only and requires no authentication.
 */
export function setupPTTHttpServer(getMainWindow: () => BrowserWindow | null): () => void {
    const server = http.createServer((req, res) => {
        if (req.method !== "POST") {
            res.writeHead(405, { "Content-Type": "text/plain" }).end("Method Not Allowed");
            return;
        }

        const win = getMainWindow();
        if (!win) {
            res.writeHead(503, { "Content-Type": "text/plain" }).end("No window");
            return;
        }

        if (req.url === "/ptt/down") {
            win.webContents.send("ptt-keydown");
            res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
        } else if (req.url === "/ptt/up") {
            win.webContents.send("ptt-keyup");
            res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
        } else {
            res.writeHead(404, { "Content-Type": "text/plain" }).end("Not Found");
        }
    });

    server.listen(PTT_HTTP_PORT, "127.0.0.1", () => {
        console.log(`PTT: HTTP server listening on http://127.0.0.1:${PTT_HTTP_PORT}`);
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
            console.error(`PTT: port ${PTT_HTTP_PORT} already in use — HTTP PTT disabled`);
        } else {
            console.error("PTT: HTTP server error:", err);
        }
    });

    return () => server.close();
}
