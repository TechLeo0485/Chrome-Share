// Friend's side: enter the host's short code, and everything else happens
// automatically via PeerJS's public broker — no reply code, no paste-back
// step. Once connected, render the video and forward mouse/keyboard input
// over the data connection.

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
let heldButton = "none";
let hostViewport = null; // the host's real window.innerWidth/innerHeight, in CSS pixels

function setJoinStatus(text, isError) {
  joinStatus.textContent = text;
  joinStatus.className = isError ? "error" : "";
}

joinBtn.addEventListener("click", () => join(hostCodeInput.value.trim()));
hostCodeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") join(hostCodeInput.value.trim());
});

function join(hostId) {
  if (!hostId) {
    setJoinStatus("Enter the code your friend sent you.", true);
    return;
  }
  joinBtn.disabled = true;
  setJoinStatus("Connecting…");

  peer = new Peer({ config: { iceServers: self.TABSHARE_RTC_CONFIG.iceServers } });

  peer.on("error", (err) => {
    setJoinStatus("Connection error: " + describePeerError(err), true);
    joinBtn.disabled = false;
  });

  peer.on("open", () => {
    dataConn = peer.connect(hostId, { reliable: true });
    wireDataConnection();
  });

  peer.on("call", (call) => {
    call.answer(); // one-way: we only receive video, we don't send our own
    call.on("stream", (stream) => {
      remoteVideo.srcObject = stream;
      showSessionScreen();
    });
    call.on("error", (err) => {
      setJoinStatus("Video call error: " + err.message, true);
    });
  });
}

function describePeerError(err) {
  if (!err) return "unknown error";
  if (err.type === "peer-unavailable") return "that code isn't an active session right now.";
  return err.type || err.message || String(err);
}

function wireDataConnection() {
  dataConn.on("open", () => {
    sessionStatus.textContent = "Connected — you're in control.";
    videoWrap.focus();
  });
  dataConn.on("data", (msg) => {
    if (msg && msg.type === "viewport-update" && msg.width && msg.height) {
      hostViewport = { width: msg.width, height: msg.height };
    } else if (msg && msg.type === "link-at-cursor") {
      showLinkPopup(msg.url);
    }
  });
  dataConn.on("close", () => {
    sessionStatus.textContent = "Disconnected.";
  });
  dataConn.on("error", (err) => {
    setJoinStatus("Data connection error: " + err.message, true);
  });
}

function showSessionScreen() {
  joinScreen.style.display = "none";
  sessionScreen.style.display = "flex";
}

leaveBtn.addEventListener("click", () => {
  cleanupAndReturnToJoinScreen("You left the session.");
});

function cleanupAndReturnToJoinScreen(message) {
  if (dataConn) {
    try { dataConn.close(); } catch (_e) {}
    dataConn = null;
  }
  if (peer) {
    try { peer.destroy(); } catch (_e) {}
    peer = null;
  }
  remoteVideo.srcObject = null;
  sessionScreen.style.display = "none";
  joinScreen.style.display = "block";
  hostCodeInput.value = "";
  joinBtn.disabled = false;
  setJoinStatus(message || "");
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
    dataConn.send(obj);
  }
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
  const { xNorm, yNorm } = normFromEvent(e);
  sendInput({ type: "mousemove", xNorm, yNorm, button: heldButton, clickCount: 0 });
});

videoWrap.addEventListener("mousedown", (e) => {
  e.preventDefault();
  videoWrap.focus();
  heldButton = buttonName(e.button);
  const { xNorm, yNorm } = normFromEvent(e);
  sendInput({ type: "mousedown", xNorm, yNorm, button: heldButton, clickCount: e.detail || 1 });
});

window.addEventListener("mouseup", (e) => {
  if (heldButton === "none") return;
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
