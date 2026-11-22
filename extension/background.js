// Service worker: owns the chrome.debugger attachment (which is what lets us inject
// *trusted* synthetic mouse/keyboard input into the shared tab) and the offscreen
// document lifecycle (WebRTC + tab capture can't run in a service worker, since it
// has no DOM/media stack — that's what chrome.offscreen is for).
//
// Two sharing modes:
//  - "tab": a single fixed tab, authorized via activeTab at invocation time.
//  - "window": scoped to a chosen window, but capture still can't silently
//    follow you to a newly-active tab — chrome.tabCapture requires a fresh,
//    tab-specific user gesture before it'll authorize capturing a tab's
//    video, and no permission (including the broad <all_urls>) substitutes
//    for that; it's a deliberate Chrome security boundary. So switching
//    which tab is shared happens by re-clicking the toolbar icon on the tab
//    you want to share next — that click is the required gesture — which
//    the popup (host.js) detects and turns into a "continue sharing with
//    this tab" action, reusing switchSharedTab() below.

const DEBUGGER_PROTOCOL_VERSION = "1.3";
let sharingTabId = null;
let sharingMode = null; // "tab" | "window" | null
let sharingWindowId = null;
let sharingTabTitle = null;
let sharingCode = null;
let friendConnected = false;

// Every "dispatch-mouse"/"dispatch-key" message below comes from the friend's
// remote input (that's the only thing that sends them) and is replayed into
// the shared tab as a real, trusted input event via chrome.debugger. That
// means a link with target="_blank", a ctrl/cmd- or middle-click, or a
// window.open() call the friend triggers opens a genuine new tab in the
// *host's* browser — one the friend can't see (only the original tab is
// captured) and the host never asked for. We can't ask Chrome to suppress
// that at the input layer, so instead we note the moment remote input last
// landed on the shared tab, and close any tab that opens from it within the
// window below. Only clicks/keys count toward that moment — mousemove is
// constant while the friend's cursor is merely hovering, and would make
// "recent input" true almost all the time, defeating the point of the guard.
// This still can't perfectly tell a remote-triggered popup apart from the
// host opening a link themselves in the same instant, but that's a rare
// coincidence next to how common target="_blank" links are.
let lastRemoteInputAt = 0;
const REMOTE_POPUP_GUARD_MS = 1500;

// Which tab was active before the current one, per window. A popup Chrome
// opens from the shared tab always becomes the active tab — but when the
// shared tab itself wasn't already active, Chrome attributes that popup's
// openerTabId to whichever tab WAS active, not to the shared tab (confirmed
// by testing; this seems to be how Chrome's tab-opening machinery keys the
// opener relationship). So openerTabId alone can't identify these popups
// when you've navigated away from the shared tab — the tabs.onCreated guard
// below also needs "what was active a moment ago, in this window" to fall
// back on, and to know what to restore. Kept per-window (not one global
// pair) so this stays correct if the host has more than one Chrome window.
const activeTabHistory = new Map(); // windowId -> { previous, current }
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  const entry = activeTabHistory.get(windowId);
  activeTabHistory.set(windowId, { previous: entry ? entry.current : null, current: tabId });
});

async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"]
  });
  if (existing.length > 0) return;
  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL("offscreen.html"),
    reasons: ["USER_MEDIA"],
    justification: "Captures the shared tab's video and runs the WebRTC peer connection."
  });
}

async function closeOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"]
  });
  if (existing.length > 0) {
    await chrome.offscreen.closeDocument();
  }
}

function attachDebugger(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      chrome.debugger.sendCommand({ tabId }, "Input.setIgnoreInputEvents", { ignore: false }, () => {
        resolve();
      });
    });
  });
}

function detachDebugger(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => resolve());
  });
}

function sendDebuggerCommand(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result);
    });
  });
}

function getStreamId(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      if (chrome.runtime.lastError || !id) {
        reject(new Error(chrome.runtime.lastError?.message || "Could not capture that tab"));
        return;
      }
      resolve(id);
    });
  });
}

async function getViewport(tabId) {
  // window.innerWidth/innerHeight are unambiguously CSS pixels, which is what
  // Input.dispatchMouseEvent expects. (Page.getLayoutMetrics has both a
  // CSS-pixel field and a device-pixel field with very similar names — on a
  // display with OS-level scaling, e.g. Windows' common 125%/150% scaling,
  // picking the wrong one silently scales every click position.)
  await sendDebuggerCommand(tabId, "Runtime.enable").catch(() => {});
  const result = await sendDebuggerCommand(tabId, "Runtime.evaluate", {
    expression: "JSON.stringify({ width: window.innerWidth, height: window.innerHeight })",
    returnByValue: true
  });
  const raw = result && result.result && result.result.value;
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch (_e) {
      /* fall through to the layout-metrics fallback below */
    }
  }
  const metrics = await sendDebuggerCommand(tabId, "Page.getLayoutMetrics");
  const size = metrics.cssVisualViewport || metrics.visualViewport || metrics.layoutViewport;
  return { width: size.clientWidth, height: size.clientHeight };
}

// A real right-click can't be forwarded as-is (see the button === "right"
// guard in offscreen.js — it would pop Chrome's native context menu on the
// *host's* screen, which the friend can't see or drive). Instead, on a
// right-click the viewer asks "what link is under the cursor right now?" so
// it can show the friend their own copy-able popup. x/y are coerced to
// finite numbers before going anywhere near the evaluated expression string.
async function getLinkAt(tabId, x, y) {
  const nx = Number(x);
  const ny = Number(y);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return null;
  await sendDebuggerCommand(tabId, "Runtime.enable").catch(() => {});
  const result = await sendDebuggerCommand(tabId, "Runtime.evaluate", {
    expression: `(() => {
      const el = document.elementFromPoint(${nx}, ${ny});
      const a = el && el.closest ? el.closest("a[href]") : null;
      return a ? a.href : null;
    })()`,
    returnByValue: true
  });
  return (result && result.result && result.result.value) || null;
}

// Switch which tab is being captured/controlled, without tearing down the
// WebRTC session. Order matters here: sharingTabId is updated *before* the
// old tab is detached, so the chrome.debugger.onDetach listener below (which
// treats a detach on sharingTabId as "user stopped sharing") doesn't
// misfire on this routine, expected detach.
async function switchSharedTab(newTabId) {
  const oldTabId = sharingTabId;
  const streamId = await getStreamId(newTabId);
  await attachDebugger(newTabId);
  sharingTabId = newTabId;
  await chrome.storage.session.set({ sharingTabId: newTabId });
  if (oldTabId != null && oldTabId !== newTabId) {
    await detachDebugger(oldTabId).catch(() => {});
  }
  chrome.runtime.sendMessage({ target: "offscreen", type: "switch-tab", tabId: newTabId, streamId }).catch(() => {});
  const tabInfo = await chrome.tabs.get(newTabId).catch(() => null);
  sharingTabTitle = tabInfo ? tabInfo.title : "";
  chrome.runtime.sendMessage({
    target: "host",
    type: "now-sharing-tab",
    title: sharingTabTitle
  }).catch(() => {});
}

// Stop sharing and clean everything up: let the offscreen document tear down
// its peer connection first, THEN detach the debugger (removes the "being
// debugged" infobar) and close the offscreen document itself.
async function stopSharing(reason) {
  const tabId = sharingTabId;
  sharingTabId = null;
  sharingMode = null;
  sharingWindowId = null;
  sharingTabTitle = null;
  sharingCode = null;
  friendConnected = false;
  await chrome.storage.session.remove("sharingTabId");

  chrome.runtime.sendMessage({ target: "offscreen", type: "end-host-session" }).catch(() => {});
  await new Promise((r) => setTimeout(r, 400)); // brief grace period for that cleanup to run

  if (tabId != null) {
    await detachDebugger(tabId).catch(() => {});
  }
  await closeOffscreenDocument().catch(() => {});
  chrome.runtime.sendMessage({ target: "host", type: "sharing-stopped", reason }).catch(() => {});
}

chrome.debugger.onDetach.addListener((source, reason) => {
  if (sharingTabId != null && source.tabId === sharingTabId) {
    stopSharing(reason || "debugger_detached");
  }
});

// offscreen.js broadcasts these to whatever host UI happens to be open
// (host-panel.js's tab). Mirror the bits the popup needs (code, whether a
// friend has connected) into module state too, so get-sharing-state can hand
// them to a popup that's opened well after these events actually fired —
// the popup itself isn't usually open continuously to have seen them live.
chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.target !== "host") return;
  if (message.type === "session-code-ready") sharingCode = message.code;
  else if (message.type === "datachannel-open") {
    friendConnected = true;
    minimizeSharedWindow();
  } else if (message.type === "datachannel-closed") friendConnected = false;
});

// Shared helper: tuck the shared window away. Called (a) the instant your
// friend actually connects and starts driving, so you're never expected to
// keep it in view just because someone else is in it, and (b) from the
// tabs.onCreated guard below, to undo the one case that's been observed to
// pull the window to the foreground on its own (a link opening a new tab).
// chrome.tabCapture streams a tab's own rendered output rather than
// mirroring the window on screen, so minimizing doesn't blank the friend's
// video (this is the same reason "tab" mode already keeps streaming if you
// switch to a different tab in that window). Bring the window back up
// yourself whenever you actually want to check in — nothing here fights
// that; it only reacts to the two moments above.
async function minimizeSharedWindow() {
  if (sharingTabId == null) return;
  const tab = await chrome.tabs.get(sharingTabId).catch(() => null);
  if (!tab) return;
  await chrome.windows.update(tab.windowId, { state: "minimized" }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== "background") return false;

  (async () => {
    try {
      switch (message.type) {
        case "start-share": {
          const { mode, tabId, windowId } = message;
          await ensureOffscreenDocument();

          // Always capture the exact tab the popup was invoked with — that's
          // the only tab Chrome will authorize on this click. (Window mode
          // re-deriving "the active tab in windowId" via a fresh query here
          // used to break this: even though it's nominally the same tab, that
          // re-query doesn't carry the activeTab grant established at the
          // moment the icon was clicked.)
          const initialTabId = tabId;
          if (mode === "window") {
            sharingMode = "window";
            sharingWindowId = windowId;
          } else {
            sharingMode = "tab";
            sharingWindowId = null;
          }
          sharingCode = null;
          friendConnected = false;
          const initialTabInfo = await chrome.tabs.get(initialTabId).catch(() => null);
          sharingTabTitle = initialTabInfo ? initialTabInfo.title : "";

          const streamId = await getStreamId(initialTabId);
          await attachDebugger(initialTabId);
          sharingTabId = initialTabId;
          await chrome.storage.session.set({ sharingTabId: initialTabId });
          chrome.runtime.sendMessage({
            target: "offscreen",
            type: "begin-host-session",
            tabId: initialTabId,
            streamId
          }).catch(() => {});
          sendResponse({ ok: true });
          break;
        }

        case "stop-share": {
          await stopSharing("user_stopped");
          sendResponse({ ok: true });
          break;
        }

        case "get-sharing-state": {
          sendResponse({
            ok: true,
            sharing: sharingTabId != null,
            mode: sharingMode,
            windowId: sharingWindowId,
            tabId: sharingTabId,
            tabTitle: sharingTabTitle,
            code: sharingCode,
            connected: friendConnected
          });
          break;
        }

        case "follow-current-tab": {
          if (sharingMode !== "window" || sharingWindowId !== message.windowId) {
            sendResponse({ ok: false, error: "Not currently sharing that window." });
            break;
          }
          await switchSharedTab(message.tabId);
          sendResponse({ ok: true });
          break;
        }

        case "get-viewport": {
          const viewport = await getViewport(message.tabId);
          sendResponse({ ok: true, viewport });
          break;
        }

        case "get-stream-id": {
          const streamId = await getStreamId(message.tabId);
          sendResponse({ ok: true, streamId });
          break;
        }

        case "get-link-at": {
          const url = await getLinkAt(message.tabId, message.x, message.y);
          sendResponse({ ok: true, url });
          break;
        }

        case "dispatch-mouse": {
          const { tabId, cdpType, x, y, button, clickCount, deltaX, deltaY } = message;
          if (cdpType === "mousePressed" || cdpType === "mouseReleased") {
            lastRemoteInputAt = Date.now();
          }
          await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", {
            type: cdpType,
            x,
            y,
            button: button || "none",
            clickCount: clickCount || 0,
            deltaX: deltaX || 0,
            deltaY: deltaY || 0,
            buttons: button && button !== "none" ? 1 : 0
          });
          sendResponse({ ok: true });
          break;
        }

        case "dispatch-key": {
          const { tabId, cdpType, code, key, keyCode, modifiers, text } = message;
          lastRemoteInputAt = Date.now();
          const params = {
            type: cdpType,
            modifiers: modifiers || 0,
            windowsVirtualKeyCode: keyCode,
            nativeVirtualKeyCode: keyCode,
            code,
            key
          };
          if (text) params.text = text;
          await sendDebuggerCommand(tabId, "Input.dispatchKeyEvent", params);
          sendResponse({ ok: true });
          break;
        }

        default:
          sendResponse({ ok: false, error: "unknown message type" });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true; // keep the message channel open for the async sendResponse above
});

// A tab opened within REMOTE_POPUP_GUARD_MS of the friend's last click/key is
// treated as them having opened a link that wanted a new tab — close it
// immediately and hand focus back to whatever tab was actually in view,
// rather than leaving a tab neither side asked to see sitting open on the
// host's machine.
//
// Whether it's "from" the shared tab isn't as simple as tab.openerTabId ===
// sharingTabId: that only holds when the shared tab happens to be the active
// one. When you've switched away to a different tab while the friend keeps
// driving the (now background) shared tab, a popup it opens still becomes
// the window's active tab, but Chrome attributes its openerTabId to
// whichever tab WAS active — not to the shared tab (confirmed by testing).
// So a popup landing in the shared tab's own window, right after remote
// input, is treated the same way even when the opener doesn't match.
//
// Creating that tab is also, empirically, the one thing in this whole flow
// that DOES pull the host's real Chrome window to the OS foreground — a
// plain synthetic click or keystroke doesn't (Windows' own anti-focus-steal
// protection blocks that), but a brand-new tab/window being created appears
// to be treated as enough of a "real" browser action for Chrome to win the
// foreground anyway. There's no extension API to hand OS focus to whatever
// non-Chrome app was running before, but minimizing the window is a genuine
// OS-level operation (unlike chrome.windows.update's `focused` flag, which
// only reasons about the browser's own windows) — so re-minimizing right
// here reliably kicks the window back down and returns focus to whatever
// you were doing.
chrome.tabs.onCreated.addListener(async (tab) => {
  if (sharingTabId == null) return;
  if (Date.now() - lastRemoteInputAt > REMOTE_POPUP_GUARD_MS) return;

  const matchesOpener = tab.openerTabId === sharingTabId;
  let matchesSharedWindow = false;
  if (!matchesOpener) {
    const sharedTab = await chrome.tabs.get(sharingTabId).catch(() => null);
    matchesSharedWindow = !!sharedTab && tab.windowId === sharedTab.windowId;
  }
  if (!matchesOpener && !matchesSharedWindow) return;

  // Restore whatever was actually on screen before this popup grabbed the
  // active-tab slot — the shared tab itself if that's what it was, but just
  // as often the tab you'd switched to for your own browsing.
  const history = activeTabHistory.get(tab.windowId);
  const previousActiveTabId = history ? history.previous : null;
  const restoreTabId =
    previousActiveTabId != null && previousActiveTabId !== tab.id ? previousActiveTabId : sharingTabId;

  chrome.tabs.remove(tab.id).catch(() => {});
  chrome.tabs.update(restoreTabId, { active: true }).catch(() => {});
  minimizeSharedWindow();
});

// If the shared tab is closed by the user directly, stop sharing (in window
// mode, re-sharing a different tab in the same window is a manual re-click
// of the toolbar icon — see follow-current-tab above).
chrome.tabs.onRemoved.addListener((tabId) => {
  if (sharingTabId === tabId) {
    stopSharing("tab_closed");
  }
});

// Whole-window mode: if the shared window itself closes, stop.
chrome.windows.onRemoved.addListener((windowId) => {
  if (sharingMode === "window" && sharingWindowId === windowId) {
    stopSharing("window_closed");
  }
});

// Resizing (or maximizing/restoring) the host's browser window changes the
// shared tab's real CSS-pixel viewport immediately. offscreen.js also polls
// for this as a fallback (it catches zoom-level changes too, which don't fire
// this event), but that poll runs on a multi-second interval — nudging it the
// moment the window itself changes size makes control feel instant instead of
// laggy after a resize. Debounced so a drag-resize (many bounds-changed events
// per second) triggers one re-capture after it settles, not a flood of them.
let viewportCheckDebounce = null;
function scheduleImmediateViewportCheck() {
  if (viewportCheckDebounce) clearTimeout(viewportCheckDebounce);
  viewportCheckDebounce = setTimeout(() => {
    viewportCheckDebounce = null;
    chrome.runtime.sendMessage({ target: "offscreen", type: "check-viewport-now" }).catch(() => {});
  }, 350);
}

chrome.windows.onBoundsChanged.addListener((win) => {
  if (sharingTabId == null) return;
  chrome.tabs
    .get(sharingTabId)
    .then((tab) => {
      if (tab && tab.windowId === win.id) scheduleImmediateViewportCheck();
    })
    .catch(() => {});
});
