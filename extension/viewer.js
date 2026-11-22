// Friend's side: enter the host's short code, and everything else happens
// automatically via PeerJS's public broker — no reply code, no paste-back
// step. Once connected, render the video and forward mouse/keyboard input
// over the data connection.
//
// Resilience: long-distance and mobile links drop often, so the viewer
// watches its own connection (heartbeat over the data channel + WebRTC
// connection state) and, if it dies, quietly rejoins the same host code with
// backoff. The host keeps the same code for the whole session and recognises
// this viewer's clientId, so the rejoin is let straight back in.
//
// If the broker itself is unreachable, the "Manual" tab connects with an
// invite/reply code exchange instead (shared/manual-link.js) — no server.

const $ = (id) => document.getElementById(id);
const joinScreen = $("joinScreen");
const hostCodeInput = $("hostCodeInput");
const nameInput = $("nameInput");
const joinBtn = $("joinBtn");
const joinStatus = $("joinStatus");
const tabCodeBtn = $("tabCodeBtn");
const tabManualBtn = $("tabManualBtn");
const codePane = $("codePane");
const manualPane = $("manualPane");
const inviteInput = $("inviteInput");
const createReplyBtn = $("createReplyBtn");
const replyOutput = $("replyOutput");
const copyReplyBtn = $("copyReplyBtn");
const manualStatus = $("manualStatus");

const sessionScreen = $("sessionScreen");
const sessionStatus = $("sessionStatus");
const statsEl = $("stats");
const viewOnlyBadge = $("viewOnlyBadge");
const qualitySelect = $("qualitySelect");
const leaveBtn = $("leaveBtn");
const videoWrap = $("videoWrap");
const remoteVideo = $("remoteVideo");
const videoOverlay = $("videoOverlay");
const linkPopup = $("linkPopup");
const linkPopupUrl = $("linkPopupUrl");
const linkPopupCopy = $("linkPopupCopy");

let peer = null;
let dataConn = null;
let mediaCall = null; // PeerJS MediaConnection, or { peerConnection, close } in manual mode
let heldButton = "none";
let hostViewport = null; // the host's real window.innerWidth/innerHeight, in CSS pixels

// ---- Connection state ----
let iceServers = null;
let currentHostId = null;
let clientId = null; // random per join; lets the host recognise our reconnects
let manualMode = false;
let inSession = false; // the host accepted us at least once for this join
let leaving = false; // user clicked Leave / gave up / was denied — no auto-reconnect
let pendingConnect = false; // connect to the host as soon as the broker is open
let awaitingApproval = false;
let controlAllowed = true;
let reconnectTimer = null;
let reconnectAttempt = 0;
let connectTimeoutTimer = null;
let heartbeatTimer = null;
let lastPongAt = 0;
let lastRttMs = null;
let prevVideoStats = null;

const CONNECT_TIMEOUT_MS = 20000; // per attempt, not counting time waiting for approval
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

// ---- Small per-viewer preferences (localStorage may be unavailable) ----
function loadPref(key, fallback) {
  try {
    const v = localStorage.getItem("tabshare." + key);
    return v == null ? fallback : v;
  } catch (_e) {
    return fallback;
  }
}
function savePref(key, value) {
  try {
    localStorage.setItem("tabshare." + key, value);
  } catch (_e) {}
}

nameInput.value = loadPref("name", "");
qualitySelect.value = loadPref("quality", "auto");
if (!qualitySelect.value) qualitySelect.value = "auto";

// ---- Status helpers ----
function setJoinStatus(text, isError) {
  joinStatus.textContent = text;
  joinStatus.className = isError ? "error" : "";
}

function setManualStatus(text, cls) {
  manualStatus.textContent = text;
  manualStatus.className = cls || "";
}

function setSessionStatus(text, cls) {
  sessionStatus.textContent = text;
  sessionStatus.className = cls || "";
}

function setOverlay(text) {
  videoOverlay.textContent = text || "";
  videoOverlay.style.display = text ? "flex" : "none";
}

// Shows progress wherever the user currently is.
function setProgress(text) {
  if (inSession) {
    setSessionStatus(text, "reconnecting");
    setOverlay(text);
  } else if (manualMode) {
    setManualStatus(text);
  } else {
    setJoinStatus(text);
  }
}

// ---- Join screen tabs ----
function selectTab(manual) {
  tabCodeBtn.classList.toggle("active", !manual);
  tabManualBtn.classList.toggle("active", manual);
  codePane.style.display = manual ? "none" : "block";
  manualPane.style.display = manual ? "block" : "none";
}
tabCodeBtn.addEventListener("click", () => selectTab(false));
tabManualBtn.addEventListener("click", () => selectTab(true));

joinBtn.addEventListener("click", () => join(hostCodeInput.value.trim()));
hostCodeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") join(hostCodeInput.value.trim());
});
nameInput.addEventListener("change", () => savePref("name", nameInput.value.trim()));

function newClientId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function resetForNewAttempt() {
  leaving = false;
  inSession = false;
  awaitingApproval = false;
  controlAllowed = true;
  reconnectAttempt = 0;
  lastRttMs = null;
  prevVideoStats = null;
  clientId = newClientId();
  savePref("name", nameInput.value.trim());
}

// ===================== Code (PeerJS broker) mode =====================

async function join(hostId) {
  if (!hostId) {
    setJoinStatus("Enter the code your friend sent you.", true);
    return;
  }
  if (hostId.startsWith("TSI1.")) {
    selectTab(true);
    inviteInput.value = hostId;
    setManualStatus("That's a manual invite code — click “Create reply code”.");
    return;
  }
  joinBtn.disabled = true;
  setJoinStatus("Connecting…");

  resetForNewAttempt();
  manualMode = false;
  currentHostId = hostId;
  iceServers = await self.TABSHARE_loadIceServers();
  pendingConnect = true;
  ensurePeerThenConnect();
}

// Makes sure we have a live connection to the broker, then connects to the
// host. Reuses the existing Peer when possible.
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
  destroyPeer();

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
      // First join: almost always a mistyped or expired code. Mid-session it
      // usually means the host is briefly reconnecting to the broker.
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
      setOverlay("");
    });
    call.on("close", () => {
      if (call !== mediaCall || leaving) return;
      scheduleReconnect();
    });
    call.on("error", () => {
      if (call !== mediaCall || leaving) return;
      scheduleReconnect();
    });
    watchPeerConnection(call.peerConnection, () => call === mediaCall);
  });
}

function connectToHost() {
  pendingConnect = false;
  closeHostConnections();

  const conn = peer.connect(currentHostId, { reliable: true });
  dataConn = conn;
  armConnectTimeout(conn);
  wireHostDataConnection(conn);
}

function armConnectTimeout(conn) {
  clearTimeout(connectTimeoutTimer);
  connectTimeoutTimer = setTimeout(() => {
    if (conn !== dataConn || leaving || awaitingApproval) return;
    scheduleReconnect();
  }, CONNECT_TIMEOUT_MS);
}

// "failed" is final; "disconnected" often heals by itself, and if it doesn't
// the heartbeat timeout catches it.
function watchPeerConnection(pc, isCurrent) {
  if (!pc) return;
  pc.addEventListener("connectionstatechange", () => {
    if (!isCurrent() || leaving) return;
    if (pc.connectionState === "failed") scheduleReconnect();
  });
}

// Data-channel handling shared by code mode and manual mode.
function wireHostDataConnection(conn) {
  conn.on("open", () => {
    if (conn !== dataConn) return;
    lastPongAt = Date.now();
    startHeartbeat();
    try {
      conn.send({ type: "hello", clientId, name: nameInput.value.trim() });
    } catch (_e) {}
    if (!inSession) setProgress("Connected — waiting for your friend…");
  });
  conn.on("data", (msg) => {
    if (conn !== dataConn || !msg) return;
    switch (msg.type) {
      case "pong":
        lastPongAt = Date.now();
        if (typeof msg.t === "number") lastRttMs = Date.now() - msg.t;
        break;
      case "awaiting-approval":
        awaitingApproval = true;
        clearTimeout(connectTimeoutTimer);
        setProgress("Waiting for your friend to let you in…");
        break;
      case "join-accepted":
        awaitingApproval = false;
        onAccepted();
        break;
      case "join-denied":
        stopWithMessage(
          msg.reason === "timeout"
            ? "Your friend didn't respond in time. Ask them to watch for your request, then try again."
            : "Your friend declined the request."
        );
        break;
      case "kicked":
        stopWithMessage("Your friend ended your access to the shared tab.");
        break;
      case "control-state":
        controlAllowed = !!msg.allowed;
        renderControlState();
        break;
      case "viewport-update":
        if (msg.width && msg.height) hostViewport = { width: msg.width, height: msg.height };
        break;
      case "link-at-cursor":
        showLinkPopup(msg.url);
        break;
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

function onAccepted() {
  clearTimeout(connectTimeoutTimer);
  reconnectAttempt = 0;
  inSession = true;
  showSessionScreen();
  if (!remoteVideo.srcObject) setOverlay("Waiting for video…");
  else setOverlay("");
  sendInput({ type: "set-quality", level: qualitySelect.value });
  renderControlState();
  renderStatus();
  videoWrap.focus();
}

// ===================== Manual (no server) mode =====================

async function createManualReply() {
  const code = inviteInput.value.trim();
  if (!code) {
    setManualStatus("Paste the invite code your friend sent you.", "error");
    return;
  }
  createReplyBtn.disabled = true;
  replyOutput.style.display = "none";
  copyReplyBtn.style.display = "none";
  setManualStatus("Creating reply… (a few seconds)");

  cleanupConnections();
  resetForNewAttempt();
  manualMode = true;
  currentHostId = null;
  iceServers = await self.TABSHARE_loadIceServers();

  let offer;
  try {
    offer = await self.TabshareManual.decode(code, "offer");
  } catch (e) {
    setManualStatus(e.message, "error");
    createReplyBtn.disabled = false;
    return;
  }

  try {
    const pc = new RTCPeerConnection({ iceServers });
    const call = {
      peerConnection: pc,
      close() {
        try {
          pc.close();
        } catch (_e) {}
      }
    };
    mediaCall = call;
    pc.addEventListener("track", (e) => {
      if (mediaCall !== call) return;
      remoteVideo.srcObject = e.streams[0] || new MediaStream([e.track]);
      setOverlay("");
    });
    pc.addEventListener("datachannel", (e) => {
      if (mediaCall !== call) return;
      const conn = self.TabshareManual.wrapChannel(e.channel);
      dataConn = conn;
      wireHostDataConnection(conn);
    });
    watchPeerConnection(pc, () => mediaCall === call);

    await pc.setRemoteDescription(offer);
    await pc.setLocalDescription(await pc.createAnswer());
    await self.TabshareManual.waitForIceGathering(pc, 6000);
    if (mediaCall !== call) return;
    replyOutput.value = await self.TabshareManual.encode(pc.localDescription);
    replyOutput.style.display = "block";
    copyReplyBtn.style.display = "";
    setManualStatus("Send this reply code to your friend. You'll connect as soon as they paste it.", "ok");
  } catch (e) {
    cleanupConnections();
    setManualStatus("Couldn't create a reply: " + e.message + ". Ask your friend for a fresh invite.", "error");
  } finally {
    createReplyBtn.disabled = false;
  }
}

createReplyBtn.addEventListener("click", createManualReply);
copyReplyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(replyOutput.value);
    copyReplyBtn.textContent = "Copied!";
  } catch (_e) {
    copyReplyBtn.textContent = "Copy failed — select and copy manually";
  }
  setTimeout(() => (copyReplyBtn.textContent = "Copy reply"), 1500);
});

// ===================== Session status, stats, quality =====================

function renderControlState() {
  viewOnlyBadge.style.display = controlAllowed ? "none" : "";
  videoWrap.classList.toggle("viewOnly", !controlAllowed);
  if (inSession && !reconnectTimer) renderStatus();
}

function renderStatus() {
  if (!controlAllowed) setSessionStatus("Connected — view only");
  else setSessionStatus("Connected — you're in control");
}

qualitySelect.addEventListener("change", () => {
  savePref("quality", qualitySelect.value);
  sendInput({ type: "set-quality", level: qualitySelect.value });
  videoWrap.focus();
});

// Reads WebRTC stats for the video connection: whether it's direct or
// relayed through a TURN server, frame rate, bitrate and packet loss.
async function updateStats() {
  const pc = mediaCall && mediaCall.peerConnection;
  if (!pc || !inSession) {
    statsEl.textContent = "";
    return;
  }
  let report;
  try {
    report = await pc.getStats();
  } catch (_e) {
    return;
  }
  const byId = new Map();
  let inbound = null;
  let selectedPairId = null;
  report.forEach((s) => {
    byId.set(s.id, s);
    if (s.type === "inbound-rtp" && s.kind === "video") inbound = s;
    if (s.type === "transport" && s.selectedCandidatePairId) selectedPairId = s.selectedCandidatePairId;
  });
  let pair = selectedPairId ? byId.get(selectedPairId) : null;
  if (!pair) {
    report.forEach((s) => {
      if (!pair && s.type === "candidate-pair" && s.nominated && s.state === "succeeded") pair = s;
    });
  }

  const parts = [];
  if (pair) {
    const local = byId.get(pair.localCandidateId);
    const remote = byId.get(pair.remoteCandidateId);
    const relayed = (local && local.candidateType === "relay") || (remote && remote.candidateType === "relay");
    parts.push(relayed ? "Relayed" : "Direct");
  }
  if (lastRttMs != null) parts.push(lastRttMs + " ms");
  if (inbound) {
    if (inbound.framesPerSecond != null) parts.push(Math.round(inbound.framesPerSecond) + " fps");
    if (prevVideoStats && inbound.timestamp > prevVideoStats.timestamp) {
      const secs = (inbound.timestamp - prevVideoStats.timestamp) / 1000;
      const kbps = ((inbound.bytesReceived - prevVideoStats.bytesReceived) * 8) / secs / 1000;
      parts.push(kbps >= 1000 ? (kbps / 1000).toFixed(1) + " Mbps" : Math.round(kbps) + " kbps");
      const lost = (inbound.packetsLost || 0) - (prevVideoStats.packetsLost || 0);
      const recv = (inbound.packetsReceived || 0) - (prevVideoStats.packetsReceived || 0);
      if (lost > 0 && lost + recv > 0) {
        const pct = (100 * lost) / (lost + recv);
        if (pct >= 1) parts.push(pct.toFixed(0) + "% loss");
      }
    }
    prevVideoStats = inbound;
  }
  statsEl.textContent = parts.join(" · ");
  const slow = lastRttMs != null && lastRttMs > SLOW_RTT_MS;
  statsEl.className = slow ? "slow" : "";
  statsEl.title = slow ? "Slow connection — try a lower quality setting if it feels laggy." : "";
}

// ===================== Heartbeat & reconnect =====================

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
    updateStats();
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

function destroyPeer() {
  if (peer) {
    try {
      peer.destroy();
    } catch (_e) {}
    peer = null;
  }
}

function cleanupConnections() {
  pendingConnect = false;
  clearTimeout(connectTimeoutTimer);
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  closeHostConnections();
  destroyPeer();
}

function scheduleReconnect() {
  if (leaving || reconnectTimer) return;

  if (manualMode) {
    // No broker means no way to redo the handshake automatically.
    if (inSession) {
      stopWithMessage("Connection lost. Manual connections can't reconnect by themselves — ask your friend for a new invite code.");
    } else {
      leaving = true;
      cleanupConnections();
      setManualStatus("Couldn't connect. Ask your friend for a fresh invite and try again — or add a TURN server in Connection settings.", "error");
    }
    return;
  }
  if (!currentHostId) return;

  clearTimeout(connectTimeoutTimer);
  closeHostConnections();
  heldButton = "none";
  lastRttMs = null;
  prevVideoStats = null;
  awaitingApproval = false;

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

// The OS says the network is back — don't sit out the rest of the backoff.
window.addEventListener("online", () => {
  if (reconnectTimer) retryNow();
});

function giveUp() {
  if (inSession) {
    stopWithMessage("Couldn't reconnect. Check your friend is still sharing, then click Leave and join again.");
  } else {
    failJoin(
      "Couldn't connect. Check your internet and that your friend is still sharing, then try again. " +
        "If the code never works, try the Manual tab."
    );
  }
}

// Ends the session but keeps the session screen up with an explanation.
function stopWithMessage(message) {
  leaving = true;
  if (!inSession) {
    if (manualMode) {
      cleanupConnections();
      setManualStatus(message, "error");
    } else {
      failJoin(message);
    }
    return;
  }
  cleanupConnections();
  setSessionStatus(message, "error");
  setOverlay(message);
  statsEl.textContent = "";
}

function failJoin(message) {
  leaving = true;
  cleanupConnections();
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
  cleanupConnections();
  currentHostId = null;
  inSession = false;
  manualMode = false;
  lastRttMs = null;
  hostViewport = null;
  remoteVideo.srcObject = null;
  sessionScreen.style.display = "none";
  joinScreen.style.display = "block";
  hostCodeInput.value = "";
  inviteInput.value = "";
  replyOutput.value = "";
  replyOutput.style.display = "none";
  copyReplyBtn.style.display = "none";
  joinBtn.disabled = false;
  setJoinStatus(message || "");
  setManualStatus("");
  setSessionStatus("Connecting…");
  setOverlay("");
  statsEl.textContent = "";
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

const CONTROL_TYPES = new Set(["mousemove", "mousedown", "mouseup", "wheel", "keydown", "keyup"]);

function sendInput(obj) {
  // View-only: the host enforces this too; skipping here just saves bandwidth.
  if (!controlAllowed && CONTROL_TYPES.has(obj.type)) return;
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
