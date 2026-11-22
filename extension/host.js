// Popup logic. Three things can happen here:
//  1. Nothing is being shared yet: show the share form (pick a tab or a
//     whole window, then hand off to host-panel.html — a persistent tab,
//     since popups close far too easily to trust with a code the user
//     needs to copy).
//  2. A share is already running: show its live status instead of the form
//     — what's being shared, whether the friend has connected yet, and the
//     code (once it's ready) — plus a way to stop. The popup itself isn't
//     open continuously, so this status has to come from background.js
//     (which keeps it around across popup opens/closes), not from replaying
//     messages the popup would otherwise have missed.
//  3. If a window-mode share is already running and you've switched to a
//     different tab in that same window, the status view also offers
//     "continue sharing with this tab". That click is what supplies the
//     fresh, tab-specific gesture chrome.tabCapture requires — there's no
//     way to automate this switch without it (see background.js's comment
//     on why).
//
// Window mode always starts from *this* window/tab, not a picker: Chrome
// only ever authorizes video capture for the tab that was active at the
// moment the extension was invoked, so offering a dropdown of other windows
// would just fail — there's no way to get a valid capture grant for a tab
// you didn't just click the icon from.

const statusArea = document.getElementById("statusArea");
const sharingTabLabel = document.getElementById("sharingTabLabel");
const statusLine = document.getElementById("statusLine");
const statusText = document.getElementById("statusText");
const popupCodeArea = document.getElementById("popupCodeArea");
const popupCodeBox = document.getElementById("popupCodeBox");
const popupCopyBtn = document.getElementById("popupCopyBtn");
const stopBtn = document.getElementById("stopBtn");

const continueArea = document.getElementById("continueArea");
const continueLabel = document.getElementById("continueLabel");
const continueBtn = document.getElementById("continueBtn");

const shareArea = document.getElementById("shareArea");
const modeRadios = document.querySelectorAll('input[name="mode"]');
const activeTabLabel = document.getElementById("activeTabLabel");
const modeHint = document.getElementById("modeHint");
const shareBtn = document.getElementById("shareBtn");
const joinBtn = document.getElementById("joinBtn");

let activeTabId = null;
let activeWindowId = null;
let mode = "tab"; // share-form selection, only relevant while nothing is sharing

// Mirrors background.js's sharing state, refreshed on open and kept live by
// the listener below while the popup stays open.
let sharingActive = false;
let sharingMode = null;
let sharingTabId = null;
let sharingWindowId = null;
let sharingTabTitle = "";
let sharingCode = null;
let sharingConnected = false;

const HINTS = {
  tab: `Chrome only allows capturing the tab that's active right now — switch to the tab you want to share (e.g. Gmail) before clicking the toolbar icon. You'll get a code to send your friend. A visible "being debugged" bar appears on the shared tab while active — that's Chrome, not this extension misbehaving.`,
  window: `Shares this window, starting with the current tab. Your friend sees whatever tab you share, but switching which tab isn't automatic — Chrome requires a fresh click for each tab you want captured. To switch, make the new tab active and click this toolbar icon again; you'll get a "Continue sharing with this tab" button here. They can't switch tabs or use the address bar themselves either way (Chrome doesn't allow extensions to control its own UI, only page content).`
};

function render() {
  if (!sharingActive) {
    statusArea.style.display = "none";
    shareArea.style.display = "block";
    return;
  }

  shareArea.style.display = "none";
  statusArea.style.display = "block";

  const modeLabel = sharingMode === "window" ? "whole window" : "one tab";
  sharingTabLabel.textContent = "Sharing " + modeLabel + (sharingTabTitle ? ": " + sharingTabTitle : "");

  if (sharingConnected) {
    statusLine.className = "connected";
    statusText.textContent = "Connected — your friend is in control.";
  } else if (sharingCode) {
    statusLine.className = "";
    statusText.textContent = "Waiting for your friend to join…";
  } else {
    statusLine.className = "";
    statusText.textContent = "Starting…";
  }

  if (sharingCode) {
    popupCodeArea.style.display = "block";
    popupCodeBox.textContent = sharingCode;
  } else {
    popupCodeArea.style.display = "none";
  }

  const canContinueHere =
    sharingMode === "window" &&
    activeWindowId != null &&
    activeWindowId === sharingWindowId &&
    activeTabId != null &&
    activeTabId !== sharingTabId;
  if (canContinueHere) {
    continueLabel.textContent = "You're on a different tab in this window right now.";
    continueArea.style.display = "block";
  } else {
    continueArea.style.display = "none";
  }
}

function applyState(state) {
  sharingActive = !!(state && state.ok && state.sharing);
  sharingMode = state ? state.mode : null;
  sharingTabId = state ? state.tabId : null;
  sharingWindowId = state ? state.windowId : null;
  sharingTabTitle = (state && state.tabTitle) || "";
  sharingCode = state ? state.code : null;
  sharingConnected = !!(state && state.connected);
  render();
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const shareable = !!(tab && /^https?:\/\//.test(tab.url || ""));
  if (tab) {
    activeTabId = tab.id;
    activeWindowId = tab.windowId;
  }

  const state = await chrome.runtime.sendMessage({ target: "background", type: "get-sharing-state" });
  applyState(state);

  // The share-form's active-tab check only matters when there's nothing to
  // show status for — a share already running elsewhere shouldn't be masked
  // just because the tab you happen to have focused right now isn't itself
  // shareable.
  if (!sharingActive) {
    if (!shareable) {
      activeTabLabel.textContent = "This tab can't be shared (not a normal web page). Switch to the tab you want to share, then reopen this popup.";
      shareBtn.disabled = true;
    } else {
      const title = tab.title && tab.title.length > 60 ? tab.title.slice(0, 60) + "…" : tab.title || tab.url;
      activeTabLabel.textContent = "Sharing: " + title;
    }
  }
}
init();

// While the popup stays open (e.g. left open waiting for a friend to join),
// reflect these live instead of only on next open.
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== "host") return;
  switch (msg.type) {
    case "session-code-ready":
      sharingActive = true;
      sharingCode = msg.code;
      render();
      break;
    case "datachannel-open":
      sharingConnected = true;
      render();
      break;
    case "datachannel-closed":
      sharingConnected = false;
      render();
      break;
    case "now-sharing-tab":
      sharingTabTitle = msg.title || "";
      render();
      break;
    case "sharing-stopped":
      sharingActive = false;
      sharingCode = null;
      sharingConnected = false;
      render();
      break;
  }
});

stopBtn.addEventListener("click", async () => {
  stopBtn.disabled = true;
  stopBtn.textContent = "Stopping…";
  await chrome.runtime.sendMessage({ target: "background", type: "stop-share" });
  sharingActive = false;
  sharingCode = null;
  sharingConnected = false;
  stopBtn.disabled = false;
  stopBtn.textContent = "Stop sharing";
  render();
});

popupCopyBtn.addEventListener("click", async () => {
  if (!sharingCode) return;
  await navigator.clipboard.writeText(sharingCode);
  popupCopyBtn.textContent = "Copied!";
  setTimeout(() => (popupCopyBtn.textContent = "Copy code"), 1500);
});

continueBtn.addEventListener("click", async () => {
  continueBtn.disabled = true;
  continueBtn.textContent = "Switching…";
  const res = await chrome.runtime.sendMessage({
    target: "background",
    type: "follow-current-tab",
    windowId: activeWindowId,
    tabId: activeTabId
  });
  if (res && res.ok) {
    window.close();
  } else {
    continueBtn.disabled = false;
    continueBtn.textContent = "Continue sharing with this tab";
    continueLabel.textContent = "Couldn't switch: " + (res && res.error ? res.error : "unknown error");
  }
});

modeRadios.forEach((r) =>
  r.addEventListener("change", () => {
    mode = document.querySelector('input[name="mode"]:checked').value;
    modeHint.textContent = HINTS[mode];
  })
);

shareBtn.addEventListener("click", async () => {
  if (!activeTabId) return;
  const url =
    mode === "window"
      ? chrome.runtime.getURL(`host-panel.html?mode=window&windowId=${activeWindowId}&tabId=${activeTabId}`)
      : chrome.runtime.getURL(`host-panel.html?mode=tab&tabId=${activeTabId}`);
  await chrome.tabs.create({ url });
  window.close();
});

joinBtn.addEventListener("click", async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL("viewer.html") });
  window.close();
});
