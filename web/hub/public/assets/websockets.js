/**
 * WebSocket management for terminal and control connections
 */

import { handleReconnection, handleDisconnected, markConnectionEstablished } from "./connection.js";
import { getBaseUrl, getWebSocketBaseUrl } from "./utils.js";
import { DeferredSizeUpdate } from "./warm.js";

/**
 * The frame's own viewport, or null when it has never been laid out.
 * A warm iframe whose document loads while display:none reports 0x0. Fitting to that
 * gives xterm's 2x1 minimum, and zellij draws the session at the smallest client size,
 * so every other viewer would see a 2 column strip.
 */
function viewportSize() {
    const viewport = window.visualViewport;
    const width = viewport ? viewport.width : window.innerWidth;
    const height = viewport ? viewport.height : window.innerHeight;
    return width > 0 && height > 0 ? { width, height } : null;
}

function updateViewportVars() {
    const size = viewportSize();
    if (!size) return;
    const root = document.documentElement;
    root.style.setProperty("--dynamic-vh", `${size.height}px`);
    root.style.setProperty("--dynamic-vw", `${size.width}px`);
}

/**
 * One place that fits xterm and reports the size to zellij.
 * Nothing is measured while the frame is suspended or has no layout. A size zellij asked
 * for in that state is owed and sent by the next fit that is allowed.
 */
function createSizer(term, fitAddon, getWsControl, getOwnWebClientId) {
    let owed = false;
    const blocked = () => window.__mcwWarm?.isSuspended() === true || viewportSize() === null;
    const send = (rows, cols) => {
        const wsControl = getWsControl();
        const ownWebClientId = getOwnWebClientId();
        if (!wsControl || !ownWebClientId || wsControl.readyState !== 1) {
            owed = true;
            return;
        }
        owed = false;
        sendSizeUpdate(wsControl, ownWebClientId, term, rows, cols);
    };
    const refit = (force) => {
        if (blocked()) {
            if (force) owed = true;
            return false;
        }
        updateViewportVars();
        const fitDimensions = fitAddon.proposeDimensions();
        if (fitDimensions === undefined) {
            console.warn("failed to get new fit dimensions");
            if (force) owed = true;
            return false;
        }
        const { rows, cols } = fitDimensions;
        const changed = rows !== term.rows || cols !== term.cols;
        if (changed) term.resize(cols, rows);
        if (changed || force || owed) send(rows, cols);
        return true;
    };
    return {
        blocked,
        refit,
        // The grid xterm was last fitted to while shown. Used when the frame was hidden
        // between that fit and the control socket opening.
        sendCurrent: () => send(term.rows, term.cols),
    };
}

/**
 * Read cell pixel dimensions from xterm.js. Tries the internal
 * _renderService first (matches what the vendored FitAddon uses) and
 * falls back to a DOM measurement of .xterm-char-measure-element, a
 * hidden helper element xterm.js creates explicitly for character
 * measurement. Returns null if neither path yields usable numbers.
 */
function getCellPixelDimensions(term) {
    try {
        const cell =
            term && term._core && term._core._renderService &&
            term._core._renderService.dimensions &&
            term._core._renderService.dimensions.css &&
            term._core._renderService.dimensions.css.cell;
        if (cell && cell.width && cell.height) {
            return { width: cell.width, height: cell.height };
        }
    } catch (_) {}
    const el = term && term.element &&
        term.element.querySelector(".xterm-char-measure-element");
    if (el) {
        const rect = el.getBoundingClientRect();
        if (rect.width && rect.height) {
            return { width: rect.width, height: rect.height };
        }
    }
    return null;
}

/**
 * Send both control messages that describe the client's display state
 * to the Zellij server: TerminalResize (grid rows/cols) and
 * TerminalMetrics (pixel dimensions used to answer host-terminal
 * queries such as CSI 14t / 16t and OSC 11;?).
 *
 * Single chokepoint so the protocol contract lives in one place. Any
 * site that updates terminal size or theme must call this helper, and
 * any future field added to the protocol is added here once. The
 * server's TerminalResize handler is idempotent, so calling this even
 * when the grid hasn't changed (e.g. after a theme reload that only
 * shifts font metrics) is safe.
 */
function sendSizeUpdate(wsControl, ownWebClientId, term, rows, cols) {
    if (!wsControl || !ownWebClientId) {
        return;
    }
    wsControl.send(
        JSON.stringify({
            web_client_id: ownWebClientId,
            payload: {
                type: "TerminalResize",
                rows,
                cols,
            },
        })
    );
    const cell = getCellPixelDimensions(term);
    if (!cell) {
        return;
    }
    wsControl.send(
        JSON.stringify({
            web_client_id: ownWebClientId,
            payload: {
                type: "TerminalMetrics",
                cell_pixel_width: Math.round(cell.width),
                cell_pixel_height: Math.round(cell.height),
                text_area_pixel_width: Math.round(cols * cell.width),
                text_area_pixel_height: Math.round(rows * cell.height),
            },
        })
    );
}

/**
 * Initialize both terminal and control WebSocket connections
 * @param {string} webClientId - Client ID from authentication
 * @param {string} sessionName - Session name from URL
 * @param {Terminal} term - Terminal instance
 * @param {FitAddon} fitAddon - Terminal fit addon
 * @param {function} sendAnsiKey - Function to send ANSI key sequences
 * @returns {object} Object containing WebSocket instances and cleanup function
 */
export function initWebSockets(
    webClientId,
    sessionName,
    term,
    fitAddon,
    sendAnsiKey
) {
    let ownWebClientId = "";
    let wsTerminal;
    let wsControl;
    let removeResumeSizeUpdate = () => {};
    let removeStartTriggers = () => {};
    let cleanedUp = false;
    const userConfig = { blink: false, style: false };
    const sizer = createSizer(term, fitAddon, () => wsControl, () => ownWebClientId);

    const wsBaseUrl = getWebSocketBaseUrl();
    const url =
        sessionName === ""
            ? `${wsBaseUrl}/ws/terminal`
            : `${wsBaseUrl}/ws/terminal/${sessionName}`;

    const queryString = `?web_client_id=${encodeURIComponent(webClientId)}`;
    const wsTerminalUrl = `${url}${queryString}`;

    // zellij counts every attached client when it sizes a session. A frame that has never
    // been shown has no size to report, so it does not attach until it is first shown.
    const startWhenSized = () => {
        if (cleanedUp || wsTerminal || sizer.blocked()) return;
        removeStartTriggers();
        sizer.refit(false);
        connect();
    };
    const connect = () => {
        wsTerminal = new WebSocket(wsTerminalUrl);

        wsTerminal.onopen = function () {
            markConnectionEstablished();
        };

        wsTerminal.onmessage = function (event) {
            if (ownWebClientId == "") {
                ownWebClientId = webClientId;
                const wsControlUrl = `${wsBaseUrl}/ws/control`;
                wsControl = new WebSocket(wsControlUrl);
                const disposeResumeSizeUpdate = startWsControl(wsControl, term, sizer, userConfig);
                removeResumeSizeUpdate = typeof disposeResumeSizeUpdate === "function" ? disposeResumeSizeUpdate : () => {};
            }

            let data = event.data;

            if (typeof data === "string") {
                // Handle ANSI title change sequences
                const titleRegex = /\x1b\]0;([^\x07\x1b]*?)(?:\x07|\x1b\\)/g;
                let match;
                while ((match = titleRegex.exec(data)) !== null) {
                    document.title = match[1];
                }

                if ((userConfig.blink || userConfig.style) && (
                    data.includes("\x1b[0 q") ||
                    data.includes("\x1b[1 q") ||
                    data.includes("\x1b[2 q") ||
                    data.includes("\x1b[3 q") ||
                    data.includes("\x1b[4 q") ||
                    data.includes("\x1b[5 q") ||
                    data.includes("\x1b[6 q")
                )) {
                    data = data.replace(/\x1b\[([0-6]) q/g, (match, p1) => {
                        const id = parseInt(p1);

                        // Decode app-requested blink and shape from DECSCUSR id
                        // id 0 = reset-to-default (null = no preference)
                        const appBlink = id === 0 ? null : (id % 2 === 1);
                        const appShapes = [null, "block", "block", "underline", "underline", "bar", "bar"];
                        const appShape  = appShapes[id];

                        // Apply user overrides only for what was explicitly configured;
                        // otherwise pass through the app's value (or fall back to term.options)
                        const effectiveBlink = userConfig.blink ? term.options.cursorBlink
                                                                : (appBlink !== null ? appBlink : term.options.cursorBlink);
                        const effectiveShape = userConfig.style ? term.options.cursorStyle
                                                                : (appShape !== null ? appShape : term.options.cursorStyle);

                        if (effectiveShape === "block")     return effectiveBlink ? "\x1b[1 q" : "\x1b[2 q";
                        if (effectiveShape === "underline") return effectiveBlink ? "\x1b[3 q" : "\x1b[4 q";
                        if (effectiveShape === "bar")       return effectiveBlink ? "\x1b[5 q" : "\x1b[6 q";
                        return match;
                    });
                }
            }

            const warm = window.__mcwWarm;
            if (warm && typeof warm.write === "function") warm.write(data);
            else term.write(data);
        };

        wsTerminal.onclose = function (event) {
            if (event.code === 4001) {
                handleDisconnected();
            } else {
                handleReconnection();
            }
        };
    };

    // Update sendAnsiKey to use the actual WebSocket
    const originalSendAnsiKey = sendAnsiKey;
    sendAnsiKey = (ansiKey) => {
        if (ownWebClientId !== "") {
            wsTerminal.send(ansiKey);
        }
    };

    // Setup resize handler
    setupResizeHandler(sizer);

    startWhenSized();
    if (!wsTerminal) {
        const removeResumeStart = window.__mcwWarm?.onResume?.(startWhenSized) || (() => {});
        addEventListener("resize", startWhenSized);
        window.visualViewport?.addEventListener("resize", startWhenSized);
        removeStartTriggers = () => {
            removeResumeStart();
            removeEventListener("resize", startWhenSized);
            window.visualViewport?.removeEventListener("resize", startWhenSized);
            removeStartTriggers = () => {};
        };
    }

    return {
        get wsTerminal() { return wsTerminal; },
        getWsControl: () => wsControl,
        getOwnWebClientId: () => ownWebClientId,
        sendAnsiKey,
        cleanup: () => {
            cleanedUp = true;
            removeStartTriggers();
            if (wsTerminal) {
                wsTerminal.close();
            }
            if (wsControl) {
                wsControl.close();
            }
            removeResumeSizeUpdate();
            removeResumeSizeUpdate = () => {};
        },
    };
}

/**
 * Start the control WebSocket and set up its handlers
 * @param {WebSocket} wsControl - Control WebSocket instance
 * @param {Terminal} term - Terminal instance
 * @param {object} sizer - The client's single fit and size reporter
 */
function startWsControl(wsControl, term, sizer, userConfig) {
    const deferredSizeUpdate = new DeferredSizeUpdate(sizer.blocked, () => sizer.refit(true));
    const removeResumeSizeUpdate = window.__mcwWarm?.onResume?.(() => deferredSizeUpdate.resume()) || (() => {});
    wsControl.onopen = function (event) {
        // Hidden after xterm was fitted but before this socket opened: register the grid
        // the frame had while shown, instead of leaving zellij at its 80x24 default.
        if (sizer.blocked()) sizer.sendCurrent();
        deferredSizeUpdate.request();
    };

    wsControl.onmessage = function (event) {
        const msg = JSON.parse(event.data);
        if (msg.type === "SetConfig") {
            const {
                font,
                theme,
                cursor_blink,
                mac_option_is_meta,
                cursor_style,
                cursor_inactive_style,
            } = msg;
            term.options.fontFamily = font;
            term.options.theme = theme;
            if (cursor_blink !== "undefined") {
                term.options.cursorBlink = cursor_blink;
                userConfig.blink = true;
            }
            if (mac_option_is_meta !== "undefined") {
                term.options.macOptionIsMeta = mac_option_is_meta;
            }
            if (cursor_style !== "undefined") {
                term.options.cursorStyle = cursor_style;
                userConfig.style = true;
            }
            if (cursor_inactive_style !== "undefined") {
                term.options.cursorInactiveStyle = cursor_inactive_style;
            }
            const body = document.querySelector("body");
            body.style.background = theme.background || "black";

            const terminal = document.getElementById("terminal");
            terminal.style.background = theme.background;

            // Always emit a size update on SetConfig: even if the grid
            // didn't change, font metrics may have shifted and the
            // pixel-cell measurements in TerminalMetrics need to
            // refresh so host-terminal queries get accurate values.
            deferredSizeUpdate.request();
        } else if (msg.type === "QueryTerminalSize") {
            deferredSizeUpdate.request();
        } else if (msg.type === "Log") {
            const { lines } = msg;
            for (const line in lines) {
                console.log(line);
            }
        } else if (msg.type === "LogError") {
            const { lines } = msg;
            for (const line in lines) {
                console.error(line);
            }
        } else if (msg.type === "SwitchedSession") {
            const { new_session_name } = msg;
            const baseUrl = getBaseUrl();
            window.location.href = `${baseUrl}/${encodeURIComponent(new_session_name)}`;
        }
    };

    wsControl.onclose = function (event) {
        if (event.code === 4001) {
            handleDisconnected();
        } else {
            handleReconnection();
        }
    };
    return removeResumeSizeUpdate;
}

/**
 * Set up window resize event handler
 * @param {object} sizer - The client's single fit and size reporter
 */
export function setupResizeHandler(sizer) {
    let resizeScheduled = false;

    const scheduleResize = () => {
        if (resizeScheduled) {
            return;
        }
        resizeScheduled = true;
        requestAnimationFrame(() => {
            resizeScheduled = false;
            sizer.refit(false);
        });
    };

    updateViewportVars();
    addEventListener("resize", scheduleResize);
    if (window.visualViewport) {
        window.visualViewport.addEventListener("resize", scheduleResize);
    }
}
