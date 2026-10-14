/**
 * Zellij 0.44.3 terminal client with a warm-frame lifecycle.
 * The lifecycle owns the real xterm terminal and real WebGL addon.
 */

import { build_link_handler } from "./links.js";
import { WarmTerminalLifecycle, browserSliceScheduler, writeWithTerminal } from "./warm.js";

function shouldUseWebgl() {
    // The warm cache uses xterm's native DOM renderer on every device.
    // It remains readable after public WebglAddon disposal and avoids GPU work while warm.
    return false;
}

export function initTerminal() {
    const term = new Terminal({
        fontFamily: "Monospace",
        allowProposedApi: true,
        scrollback: 0,
    });
    window.term = term;
    const fitAddon = new FitAddon.FitAddon();
    const clipboardAddon = new ClipboardAddon.ClipboardAddon();
    const { linkHandler, activateLink } = build_link_handler();
    const webLinksAddon = new WebLinksAddon.WebLinksAddon(activateLink, linkHandler);
    term.options.linkHandler = linkHandler;

    let webglAddon = null;
    const releaseWebgl = function () {
        if (!webglAddon) return;
        webglAddon.dispose();
        webglAddon = null;
    };
    const recreateWebgl = function () {
        const addon = new WebglAddon.WebglAddon();
        addon.onContextLoss(() => {
            if (webglAddon === addon) {
                addon.dispose();
                webglAddon = null;
            }
        });
        term.loadAddon(addon);
        webglAddon = addon;
    };

    term.loadAddon(fitAddon);
    term.loadAddon(clipboardAddon);
    term.loadAddon(webLinksAddon);
    term.open(document.getElementById("terminal"));
    if (shouldUseWebgl()) {
        try {
            recreateWebgl();
        } catch (_) {
            webglAddon = null;
        }
    }
    // A warm frame that loads while display:none has a 0x0 viewport. It is fitted when first shown.
    if (window.innerWidth > 0 && window.innerHeight > 0) fitAddon.fit();
    term.focus();

    const lifecycle = new WarmTerminalLifecycle({
        write: (payload) => writeWithTerminal(term, payload),
        schedule: browserSliceScheduler(window),
        suspendRenderer: () => {},
        resumeRenderer: () => {},
        releaseWebgl,
        recreateWebgl: () => { if (shouldUseWebgl()) recreateWebgl(); },
        setCursorBlink: (value) => { term.options.cursorBlink = value; },
        refresh: () => term.refresh(0, term.rows - 1),
    });
    const resumeCallbacks = new Set();
    window.__mcwWarm = {
        suspend: () => lifecycle.suspend(term.options.cursorBlink),
        resume: () => lifecycle.resume(),
        write: (payload) => lifecycle.write(payload),
        isSuspended: () => lifecycle.suspended,
        queuedUnits: () => lifecycle.queuedUnits,
        parseStats: () => lifecycle.parseStats,
        onResume: (callback) => {
            resumeCallbacks.add(callback);
            return () => resumeCallbacks.delete(callback);
        },
    };
    const originalResume = window.__mcwWarm.resume;
    window.__mcwWarm.resume = async () => {
        await originalResume();
        for (const callback of resumeCallbacks) callback();
    };
    const updateRenderPolicy = () => {
        if (!shouldUseWebgl()) {
            releaseWebgl();
            return;
        }
        if (!lifecycle.suspended && !webglAddon) {
            try { recreateWebgl(); } catch (_) { webglAddon = null; }
        }
    };
    addEventListener("resize", updateRenderPolicy);
    window.__mcwWarm.updateRenderPolicy = updateRenderPolicy;

    return { term, fitAddon };
}
