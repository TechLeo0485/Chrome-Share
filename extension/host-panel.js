const params = new URLSearchParams(location.search);
const mode = params.get("mode") === "window" ? "window" : "tab";
const tabId = Number(params.get("tabId"));
const windowId = Number(params.get("windowId"));

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const step1 = $("step1");
const codeBox = $("codeBox");
const copyCodeBtn = $("copyCodeBtn");
const stopBtn = $("stopBtn");
const nowSharingEl = $("nowSharing");
const switchHintEl = $("switchHint");

const joinRequestCard = $("joinRequest");
const joinRequestText = $("joinRequestText");
const allowBtn = $("allowBtn");
const denyBtn = $("denyBtn");

const friendCard = $("friendCard");
const friendTitle = $("friendTitle");
const controlToggle = $("controlToggle");
const kickBtn = $("kickBtn");

const manualCard = $("manualCard");
const createInviteBtn = $("createInviteBtn");
const copyInviteBtn = $("copyInviteBtn");
const inviteBox = $("inviteBox");
const replyBox = $("replyBox");
const connectReplyBtn = $("connectReplyBtn");
const manualStatus = $("manualStatus");

const BASE_TITLE = document.title;
let currentCode = "";
let connected = false;
let friendName = "";
let pendingRequestId = null;
let stopped = false;

if (mode === "window") switchHintEl.classList.remove("hidden");

function show(el, visible) {
  el.classList.toggle("hidden", !visible);
}

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = cls || "";
}

function toOffscreen(type, extra) {
  chrome.runtime.sendMessage({ target: "offscreen", type, ...(extra || {}) }).catch(() => {});
}

function setManualStatus(text, cls) {
  manualStatus.textContent = text;
  manualStatus.className = cls || "";
}

function showConnectedStatus() {
  const who = friendName || "Your friend";
  if (controlToggle.checked) setStatus(who + " is connected and can control this tab.", "connected");
  else setStatus(who + " is connected — view only.", "connected");
}

function showIdleStatus() {
  if (currentCode) setStatus("Waiting for your friend — send them the code below.");
}

async function start() {
  setStatus("Starting tab capture…");
  const res = await chrome.runtime.sendMessage({
    target: "background",
    type: "start-share",
    mode,
    tabId,
    windowId: mode === "window" ? windowId : undefined
  });
  if (!res || !res.ok) {
    setStatus("Couldn't start sharing: " + (res && res.error ? res.error : "unknown error"), "error");
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== "host" || stopped) return;

  switch (msg.type) {
    case "session-code-ready":
      // Also fires again (same code) after recovering from a broker drop.
      currentCode = msg.code;
      codeBox.textContent = msg.code;
      show(step1, true);
      show(manualCard, true);
      if (connected) showConnectedStatus();
      else showIdleStatus();
      break;

    case "broker-reconnecting":
      // The manual option needs no broker, so make sure it's visible.
      show(manualCard, true);
      if (connected) {
        showConnectedStatus();
      } else {
        setStatus(
          "Can't reach the connection service right now — retrying automatically (your code stays the same). " +
            "If it keeps failing, use “Connect manually” below.",
          "error"
        );
      }
      break;

    case "join-request":
      pendingRequestId = msg.requestId;
      joinRequestText.textContent = (msg.name || "Someone") + " wants to join";
      show(joinRequestCard, true);
      allowBtn.disabled = false;
      denyBtn.disabled = false;
      setStatus((msg.name || "Someone") + " is asking to join — allow or deny below.", "waiting");
      document.title = "🔔 Join request — TabShare";
      break;

    case "join-resolved":
      pendingRequestId = null;
      show(joinRequestCard, false);
      document.title = BASE_TITLE;
      if (!connected) {
        if (msg.outcome === "timeout") setStatus("A join request expired (no answer for 90 seconds). They can try again with the same code.");
        else if (msg.outcome === "left") setStatus("The person asking to join gave up or lost connection.");
        else showIdleStatus();
      }
      break;

    case "datachannel-open":
      connected = true;
      friendName = msg.name || "Your friend";
      friendTitle.textContent = friendName + " is connected";
      if (typeof msg.controlAllowed === "boolean") controlToggle.checked = msg.controlAllowed;
      show(friendCard, true);
      showConnectedStatus();
      if (/manual/.test(friendName)) setManualStatus("Connected!", "ok");
      break;

    case "datachannel-closed":
      connected = false;
      show(friendCard, false);
      if (msg.kicked) {
        setStatus("You disconnected your friend. They'll need your permission to rejoin.");
      } else {
        setStatus("Your friend's connection dropped. Their viewer reconnects automatically — or they can rejoin with the same code.", "waiting");
      }
      break;

    case "manual-invite-ready":
      inviteBox.value = msg.code;
      show(inviteBox, true);
      show(copyInviteBtn, true);
      createInviteBtn.disabled = false;
      createInviteBtn.textContent = "Create a new invite";
      setManualStatus("Invite ready — copy it and send it to your friend, then paste their reply below.");
      break;

    case "manual-reply-accepted":
      setManualStatus("Reply accepted — connecting…");
      break;

    case "manual-error":
      createInviteBtn.disabled = false;
      setManualStatus(msg.error, "error");
      break;

    case "now-sharing-tab":
      nowSharingEl.textContent = msg.title ? "Currently sharing: " + msg.title : "";
      break;

    case "session-error":
      setStatus(msg.error, "error");
      break;

    case "sharing-stopped":
      stopped = true;
      setStatus("Sharing stopped" + (msg.reason ? " (" + msg.reason.replace(/_/g, " ") + ")" : "") + ". You can close this tab.");
      [step1, manualCard, friendCard, joinRequestCard].forEach((el) => show(el, false));
      stopBtn.disabled = true;
      document.title = BASE_TITLE;
      break;
  }
});

allowBtn.addEventListener("click", () => {
  if (!pendingRequestId) return;
  allowBtn.disabled = denyBtn.disabled = true;
  toOffscreen("join-decision", { requestId: pendingRequestId, allow: true });
});

denyBtn.addEventListener("click", () => {
  if (!pendingRequestId) return;
  allowBtn.disabled = denyBtn.disabled = true;
  toOffscreen("join-decision", { requestId: pendingRequestId, allow: false });
});

controlToggle.addEventListener("change", () => {
  toOffscreen("set-control-allowed", { allowed: controlToggle.checked });
  if (connected) showConnectedStatus();
});

kickBtn.addEventListener("click", () => {
  toOffscreen("kick-friend");
});

async function copyWithFeedback(btn, text, label) {
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = "Copied!";
  } catch (_e) {
    btn.textContent = "Copy failed — select and copy manually";
  }
  setTimeout(() => (btn.textContent = label), 1500);
}

copyCodeBtn.addEventListener("click", () => {
  if (currentCode) copyWithFeedback(copyCodeBtn, currentCode, "Copy code");
});

createInviteBtn.addEventListener("click", () => {
  createInviteBtn.disabled = true;
  inviteBox.value = "";
  setManualStatus("Creating invite… (a few seconds)");
  toOffscreen("manual-create-invite");
});

copyInviteBtn.addEventListener("click", () => {
  if (inviteBox.value) copyWithFeedback(copyInviteBtn, inviteBox.value, "Copy invite");
});

connectReplyBtn.addEventListener("click", () => {
  const code = replyBox.value.trim();
  if (!code) {
    setManualStatus("Paste the reply code your friend sent back.", "error");
    return;
  }
  setManualStatus("Checking reply…");
  toOffscreen("manual-accept-reply", { code });
});

stopBtn.addEventListener("click", async () => {
  setStatus("Stopping…");
  await chrome.runtime.sendMessage({ target: "background", type: "stop-share" });
});

if (!tabId) {
  setStatus("Missing tab to share — close this tab and try again from the extension popup.", "error");
} else if (mode === "window" && !windowId) {
  setStatus("Missing window to share — close this tab and try again from the extension popup.", "error");
} else {
  start();
}
