// Friend's side: enter the host's short code, and everything else happens
// automatically via PeerJS's public broker — no reply code, no paste-back
// step. Once connected, render the video and forward mouse/keyboard input
// over the data connection.
//
// Resilience: long-distance and mobile links drop often, so the viewer
// watches its own connection (heartbeat over the data channel + WebRTC
// connection state) and, if it dies, quietly rejoins the same host code with
// backoff. The host keeps the same code for the whole session and accepts the
// rejoin in place of the stale connection, so nobody has to re-send anything.

const joinScreen = document.getElementById("joinScreen");
const hostCodeInput = document.getElementById("hostCodeInput");
const joinBtn = document.getElementById("joinBtn");
const joinStatus = document.getElementById("joinStatus");

const sessionScreen = document.getElementById("sessionScreen");
const sessionStatus = document.getElementById("sessionStatus");
const leaveBtn = document.getElementById("leaveBtn");
const videoWrap = document.getElementById("videoWrap");
const remoteVideo = document.getElementById("remoteVideo");
const linkPopup = document.getElementById("linkPopup");
const linkPopupUrl = document.getElementById("linkPopupUrl");
const linkPopupCopy = document.getElementById("linkPopupCopy");

let peer = null;
let dataConn = null;
let mediaCall = null;
let heldButton = "none";
let hostViewport = null; // the host's real window.innerWidth/innerHeight, in CSS pixels

// ---- Connection state ----
let iceServers = null;
let currentHostId = null;
let inSession = false; // video has been shown at least once for this join
let leaving = false; // user clicked Leave / gave up — suppress auto-reconnect
let pendingConnect = false; // connect to the host as soon as the broker is open
let reconnectTimer = null;
let reconnectAttempt = 0;
let connectTimeoutTimer = null;
let heartbeatTimer = null;
let lastPongAt = 0;
let lastRttMs = null;

const CONNECT_TIMEOUT_MS = 20000; // per attempt: data channel open + video arriving
const HEARTBEAT_MS = 2000;
const HEARTBEAT_TIMEOUT_MS = 10000;
const MAX_RECONNECT_ATTEMPTS = 30; // ~4–5 minutes with the backoff below
const RECONNECT_MAX_DELAY_MS = 10000;
const SLOW_RTT_MS = 400;
// PeerJS error types that mean "network hiccup", worth retrying.
const RECOVERABLE_PEER_ERRORS = new Set([
  "network",
  "server-error",
  "socket-error",
  "socket-closed",
  "disconnected",
  "webrtc"
]);

function setJoinStatus(text, isError) {
  joinStatus.textContent = text;
  joinStatus.className = isError ? "error" : "";
}

function setSessionStatus(text, cls) {
  sessionStatus.textContent = text;
  sessionStatus.className = cls || "";
}

// Shows progress wherever the user currently is (join screen or session).
function setProgress(text) {
  if (inSession) setSessionStatus(text, "reconnecting");
  else setJoinStatus(text);
}

joinBtn.addEventListener("click", () => join(hostCodeInput.value.trim()));
hostCodeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") join(hostCodeInput.value.trim());
});

async function join(hostId) {
  if (!hostId) {
    setJoinStatus("Enter the code your friend sent you.", true);
    return;
  }
  joinBtn.disabled = true;
  setJoinStatus("Connecting…");

  leaving = false;
  inSession = false;
  currentHostId = hostId;
  reconnectAttempt = 0;
  iceServers = await self.TABSHARE_loadIceServers();
  pendingConnect = true;
  ensurePeerThenConnect();
}

// Makes sure we have a live connection to the broker, then connects to the
// host. Reuses the existing Peer when possible (cheaper and faster than a new
// broker registration).
function ensurePeerThenConnect() {
  if (peer && !peer.destroyed && peer.open) {
    connectToHost();
    return;
  }
  if (peer && !peer.destroyed && peer.disconnected) {
    try {
      peer.reconnect(); // "open" fires again → connectToHost()
      return;
    } catch (_e) {
      /* fall through to a fresh Peer */
    }
  }
  if (peer) {
    try {
      peer.destroy();
    } catch (_e) {}
  }

  const p = new Peer({ config: { iceServers } });
  peer = p;

  p.on("open", () => {
    if (p !== peer || !pendingConnect) return;
    connectToHost();
  });

  // Losing the broker doesn't affect a live session (video/input are
  // peer-to-peer). It only matters if we were in the middle of connecting.
  p.on("disconnected", () => {
    if (p !== peer || leaving) return;
    if (pendingConnect || !dataConn) scheduleReconnect();
  });

  p.on("error", (err) => {
    if (p !== peer || leaving) return;
    const type = err && err.type;
    if (type === "peer-unavailable") {
      // On the very first join this almost always means a mistyped or
      // expired code. Mid-session it usually means the host is itself
      // briefly reconnecting to the broker — keep trying.
      if (!inSession) failJoin("That code isn't an active session right now. Check it and try again.");
      else scheduleReconnect();
      return;
    }
    if (RECOVERABLE_PEER_ERRORS.has(type)) {
      scheduleReconnect();
      return;
    }
    if (!inSession) failJoin("Connection error: " + (type || err.message || String(err)));
    else scheduleReconnect();
  });

  p.on("call", (call) => {
    if (p !== peer || leaving) return;
    if (mediaCall && mediaCall !== call) {
      try {
        mediaCall.close();
      } catch (_e) {}
    }
    mediaCall = call;
    call.answer(); // one-way: we only receive video, we don't send our own
    call.on("stream", (stream) => {
      if (call !== mediaCall) return;
      remoteVideo.srcObject = stream;
      onConnected();
    });
    call.on("close", () => {
      if (call !== mediaCall || leaving) return;
      scheduleReconnect();
    });
    call.on("error", () => {
      if (call !== mediaCall || leaving) return;
      scheduleReconnect();
    });
    // "failed" is final; "disconnected" often heals by itself, and if it
    // doesn't the heartbeat timeout below catches it.
    const pc = call.peerConnection;
    if (pc) {
      pc.addEventListener("connectionstatechange", () => {
        if (call !== mediaCall || leaving) return;
        if (pc.connectionState === "failed") scheduleReconnect();
      });
    }
  });
}

function connectToHost() {
  pendingConnect = false;
  closeHostConnections();

  const conn = peer.connect(currentHostId, { reliable: true });
  dataConn = conn;

  clearTimeout(connectTimeoutTimer);
  connectTimeoutTimer = setTimeout(() => {
    if (conn !== dataConn || leaving) return;
    scheduleReconnect();
  }, CONNECT_TIMEOUT_MS);

  conn.on("open", () => {
    if (conn !== dataConn) return;
    lastPongAt = Date.now();
    startHeartbeat();
    setProgress("Connected — waiting for video…");
  });
  conn.on("data", (msg) => {
    if (conn !== dataConn || !msg) return;
    if (msg.type === "pong") {
      lastPongAt = Date.now();
      if (typeof msg.t === "number") {
        lastRttMs = Date.now() - msg.t;
        if (inSession && !reconnectTimer) showConnectedStatus();
      }
    } else if (msg.type === "viewport-update" && msg.width && msg.height) {
      hostViewport = { width: msg.width, height: msg.height };
    } else if (msg.type === "link-at-cursor") {
      showLinkPopup(msg.url);
    }
  });
  conn.on("close", () => {
    if (conn !== dataConn || leaving) return;
    scheduleReconnect();
  });
  conn.on("error", () => {
    if (conn !== dataConn || leaving) return;
    scheduleReconnect();
  });
}

function onConnected() {
  clearTimeout(connectTimeoutTimer);
  reconnectAttempt = 0;
  inSession = true;
  showSessionScreen();
  showConnectedStatus();
  videoWrap.focus();
}

function showConnectedStatus() {
  if (lastRttMs == null) {
    setSessionStatus("Connected — you're in control.");
  } else if (lastRttMs > SLOW_RTT_MS) {
    setSessionStatus("Connected — you're in control · " + lastRttMs + " ms (slow connection, expect lag)", "slow");
  } else {
    setSessionStatus("Connected — you're in control · " + lastRttMs + " ms");
  }
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (!dataConn || !dataConn.open) return;
    if (Date.now() - lastPongAt > HEARTBEAT_TIMEOUT_MS) {
      scheduleReconnect();
      return;
    }
    try {
      dataConn.send({ type: "ping", t: Date.now() });
    } catch (_e) {}
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

// Closes our side of the host connections without triggering reconnects
// (handlers ignore events from connections that are no longer current).
function closeHostConnections() {
  stopHeartbeat();
  const oldData = dataConn;
  const oldCall = mediaCall;
  dataConn = null;
  mediaCall = null;
  if (oldData) {
    try {
      oldData.close();
    } catch (_e) {}
  }
  if (oldCall) {
    try {
      oldCall.close();
    } catch (_e) {}
  }
}

function scheduleReconnect() {
  if (leaving || reconnectTimer || !currentHostId) return;
  clearTimeout(connectTimeoutTimer);
  closeHostConnections();
  heldButton = "none";
  lastRttMs = null;

  reconnectAttempt++;
  if (reconnectAttempt > MAX_RECONNECT_ATTEMPTS) {
    giveUp();
    return;
  }
  const delay = Math.min(1000 * 2 ** (reconnectAttempt - 1), RECONNECT_MAX_DELAY_MS);
  setProgress(
    (inSession ? "Connection lost — reconnecting" : "Couldn't connect yet — retrying") +
      " (attempt " + reconnectAttempt + " of " + MAX_RECONNECT_ATTEMPTS + ")…"
  );
  reconnectTimer = setTimeout(retryNow, delay);
}

function retryNow() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (leaving || !currentHostId) return;
  pendingConnect = true;
  ensurePeerThenConnect();
}

// The OS says the network is back (Wi-Fi rejoined, mobile data returned) —
// don't sit out the rest of the backoff delay.
window.addEventListener("online", () => {
  if (reconnectTimer) retryNow();
});

function giveUp() {
  if (inSession) {
    leaving = true;
    closeHostConnections();
    setSessionStatus("Couldn't reconnect. Check your friend is still sharing, then click Leave and join again.", "error");
  } else {
    failJoin(
      "Couldn't connect. Check your internet, make sure your friend is still sharing, and try again. " +
        "On very restrictive networks, adding a TURN server in Connection settings can help."
    );
  }
}

function failJoin(message) {
  leaving = true;
  clearTimeout(connectTimeoutTimer);
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  closeHostConnections();
  if (peer) {
    try {
      peer.destroy();
    } catch (_e) {}
    peer = null;
  }
  currentHostId = null;
  joinBtn.disabled = false;
  setJoinStatus(message, true);
}

function showSessionScreen() {
  joinScreen.style.display = "none";
  sessionScreen.style.display = "flex";
}

leaveBtn.addEventListener("click", () => {
  cleanupAndReturnToJoinScreen("You left the session.");
});

function cleanupAndReturnToJoinScreen(message) {
  leaving = true;
  pendingConnect = false;
  clearTimeout(connectTimeoutTimer);
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  closeHostConnections();
  if (peer) {
    try { peer.destroy(); } catch (_e) {}
    peer = null;
  }
  currentHostId = null;
  inSession = false;
  lastRttMs = null;
  hostViewport = null;
  remoteVideo.srcObject = null;
  sessionScreen.style.display = "none";
  joinScreen.style.display = "block";
  hostCodeInput.value = "";
  joinBtn.disabled = false;
  setJoinStatus(message || "");
  setSessionStatus("Connecting…");
  hideLinkPopup();
}

// ---- Right-click → "what link is under the cursor?" → copy. A real right-
// click can't be forwarded (it would pop the host's own native context menu
// on their screen — see the button === "right" guard in offscreen.js), so
// this asks the host tab directly and shows the answer as our own popup. ----

let pendingLinkPos = null;
let linkPopupHideTimer = null;

function hideLinkPopup() {
  clearTimeout(linkPopupHideTimer);
  linkPopup.style.display = "none";
  linkPopupCopy.classList.remove("copied");
  linkPopupCopy.textContent = "Copy link";
  linkPopupCopy.style.display = "";
}

function showLinkPopup(url) {
  if (!pendingLinkPos) return;
  clearTimeout(linkPopupHideTimer);
  linkPopupCopy.classList.remove("copied");
  linkPopupCopy.textContent = "Copy link";

  if (!url) {
    linkPopupUrl.textContent = "No link here";
    linkPopupUrl.classList.add("empty");
    linkPopupCopy.style.display = "none";
  } else {
    linkPopupUrl.textContent = url;
    linkPopupUrl.title = url;
    linkPopupUrl.classList.remove("empty");
    linkPopupCopy.style.display = "";
    linkPopupCopy.dataset.url = url;
  }

  linkPopup.style.display = "flex";
  const wrapRect = videoWrap.getBoundingClientRect();
  let left = pendingLinkPos.clientX - wrapRect.left + 8;
  let top = pendingLinkPos.clientY - wrapRect.top + 8;
  left = Math.max(4, Math.min(left, wrapRect.width - linkPopup.offsetWidth - 4));
  top = Math.max(4, Math.min(top, wrapRect.height - linkPopup.offsetHeight - 4));
  linkPopup.style.left = left + "px";
  linkPopup.style.top = top + "px";

  if (!url) {
    linkPopupHideTimer = setTimeout(hideLinkPopup, 1400);
  }
}

linkPopupCopy.addEventListener("click", () => {
  const url = linkPopupCopy.dataset.url;
  if (!url) return;
  navigator.clipboard
    .writeText(url)
    .then(() => {
      linkPopupCopy.textContent = "Copied!";
      linkPopupCopy.classList.add("copied");
      linkPopupHideTimer = setTimeout(hideLinkPopup, 900);
    })
    .catch(() => {
      linkPopupCopy.textContent = "Copy failed";
    });
});

document.addEventListener("mousedown", (e) => {
  if (linkPopup.style.display !== "none" && !linkPopup.contains(e.target)) {
    hideLinkPopup();
  }
});

// ---- Input capture: translate the viewer's mouse/keyboard into normalized
// coordinates + CDP-shaped key data, and forward over the data connection. ----

function sendInput(obj) {
  if (dataConn && dataConn.open) {
    try {
      dataConn.send(obj);
    } catch (_e) {
      /* channel closing — the reconnect logic takes it from here */
    }
  }
}

// If this much is already queued on the data channel the link is congested;
// skip non-essential mouse moves so clicks and keys aren't stuck behind them.
const CONGESTED_BUFFER_BYTES = 64 * 1024;

function isCongested() {
  const ch = dataConn && dataConn.dataChannel;
  return !!ch && ch.bufferedAmount > CONGESTED_BUFFER_BYTES;
}

// Mouse moves fire up to hundreds of times a second; send at most one per
// animation frame (only the latest position matters).
let pendingMove = null;
let moveFrameScheduled = false;

function flushPendingMove() {
  if (!pendingMove) return;
  const move = pendingMove;
  pendingMove = null;
  if (isCongested() && heldButton === "none") return; // plain hover: safe to drop
  sendInput({ type: "mousemove", xNorm: move.xNorm, yNorm: move.yNorm, button: heldButton, clickCount: 0 });
}

function getContentRect(video) {
  const rect = video.getBoundingClientRect();
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return rect;
  const elAspect = rect.width / rect.height;
  // Prefer the host's real page aspect ratio (sent alongside the offer) over
  // the captured video stream's own pixel dimensions — tab-capture's encoded
  // resolution doesn't always exactly preserve the page's true CSS aspect
  // ratio, and even a small mismatch here shifts click positions, worse the
  // further from center you click.
  const vidAspect = hostViewport ? hostViewport.width / hostViewport.height : vw / vh;
  let contentWidth, contentHeight, offsetX, offsetY;
  if (vidAspect > elAspect) {
    contentWidth = rect.width;
    contentHeight = rect.width / vidAspect;
    offsetX = 0;
    offsetY = (rect.height - contentHeight) / 2;
  } else {
    contentHeight = rect.height;
    contentWidth = rect.height * vidAspect;
    offsetY = 0;
    offsetX = (rect.width - contentWidth) / 2;
  }
  return { left: rect.left + offsetX, top: rect.top + offsetY, width: contentWidth, height: contentHeight };
}

function normFromEvent(e) {
  const cr = getContentRect(remoteVideo);
  let xNorm = (e.clientX - cr.left) / cr.width;
  let yNorm = (e.clientY - cr.top) / cr.height;
  xNorm = Math.min(1, Math.max(0, xNorm));
  yNorm = Math.min(1, Math.max(0, yNorm));
  return { xNorm, yNorm };
}

function buttonName(button) {
  if (button === 0) return "left";
  if (button === 1) return "middle";
  if (button === 2) return "right";
  return "none";
}

videoWrap.addEventListener("mousemove", (e) => {
  pendingMove = normFromEvent(e);
  if (moveFrameScheduled) return;
  moveFrameScheduled = true;
  requestAnimationFrame(() => {
    moveFrameScheduled = false;
    flushPendingMove();
  });
});

videoWrap.addEventListener("mousedown", (e) => {
  e.preventDefault();
  videoWrap.focus();
  flushPendingMove();
  heldButton = buttonName(e.button);
  const { xNorm, yNorm } = normFromEvent(e);
  sendInput({ type: "mousedown", xNorm, yNorm, button: heldButton, clickCount: e.detail || 1 });
});

window.addEventListener("mouseup", (e) => {
  if (heldButton === "none") return;
  flushPendingMove();
  const button = buttonName(e.button);
  const { xNorm, yNorm } = normFromEvent(e);
  sendInput({ type: "mouseup", xNorm, yNorm, button, clickCount: e.detail || 1 });
  heldButton = "none";
});

videoWrap.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const { xNorm, yNorm } = normFromEvent(e);
  pendingLinkPos = { clientX: e.clientX, clientY: e.clientY };
  sendInput({ type: "query-link", xNorm, yNorm });
});

videoWrap.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const { xNorm, yNorm } = normFromEvent(e);
    sendInput({ type: "wheel", xNorm, yNorm, button: "none", deltaX: e.deltaX, deltaY: e.deltaY });
  },
  { passive: false }
);

function modifiersBitmask(e) {
  let m = 0;
  if (e.altKey) m |= 1;
  if (e.ctrlKey) m |= 2;
  if (e.metaKey) m |= 4;
  if (e.shiftKey) m |= 8;
  return m;
}

videoWrap.addEventListener("keydown", (e) => {
  e.preventDefault();
  // Enter needs an explicit "\r" text payload even though it isn't a printable
  // character — Chrome's CDP Input.dispatchKeyEvent only synthesizes the
  // keypress/input step (form submit, newline insertion, onkeypress handlers)
  // when a key event carries text, and Enter is the one control key that
  // relies on that step.
  const text =
    e.key === "Enter"
      ? "\r"
      : e.key.length === 1 && !e.ctrlKey && !e.metaKey
        ? e.key
        : undefined;
  sendInput({
    type: "keydown",
    code: e.code,
    key: e.key,
    keyCode: e.keyCode,
    modifiers: modifiersBitmask(e),
    text
  });
});

videoWrap.addEventListener("keyup", (e) => {
  e.preventDefault();
  sendInput({
    type: "keyup",
    code: e.code,
    key: e.key,
    keyCode: e.keyCode,
    modifiers: modifiersBitmask(e)
  });
});
