// Runs in the hidden offscreen document (host side only). Captures the shared
// tab's video/audio and relays incoming input events from the friend to the
// background service worker for injection via chrome.debugger.
//
// Signaling uses PeerJS (shared/vendor/peerjs.min.js) against its free public
// broker (0.peerjs.com) — no server of our own, no account, and no manual
// code-pasting round trip: the friend enters one short ID and everything
// else (offer/answer/ICE) happens automatically over that broker. The actual
// video/audio/input still flows directly peer-to-peer, same as before.

let peer = null;
let dataConn = null;
let mediaConn = null;
let localStream = null;
let currentAudioCtx = null;
let currentTabId = null;
let currentViewport = null;
let viewportWatcherTimer = null;
// True while a capture is being torn down and replaced (tab switch, or a
// resize re-capture) — guards against the two racing each other.
let captureBusy = false;

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== "offscreen") return;
  if (msg.type === "begin-host-session") beginHostSession(msg.tabId, msg.streamId);
  if (msg.type === "switch-tab") switchCapturedTab(msg.tabId, msg.streamId);
  if (msg.type === "check-viewport-now") checkViewportOnce();
  if (msg.type === "end-host-session") endHostSession();
});

function randomPeerId() {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return "tabshare-" + hex;
}

// Captures a tab at its own real CSS-pixel size (so the frame always matches
// the live page 1:1, which is what keeps click-coordinate mapping accurate)
// and loops its audio back to the host's speakers (getUserMedia on a tab
// silences its normal output). Shared by the initial capture and by
// switchCapturedTab() when following the active tab in window-sharing mode.
async function captureTab(tabId, streamId) {
  const viewport = await requestViewport(tabId);
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    },
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
        minWidth: viewport.width,
        maxWidth: viewport.width,
        minHeight: viewport.height,
        maxHeight: viewport.height,
        maxFrameRate: 30
      }
    }
  });

  if (currentAudioCtx) {
    try {
      currentAudioCtx.close();
    } catch (_e) {}
    currentAudioCtx = null;
  }
  try {
    currentAudioCtx = new AudioContext();
    const src = currentAudioCtx.createMediaStreamSource(stream);
    src.connect(currentAudioCtx.destination);
  } catch (_e) {
    /* non-fatal */
  }

  return { stream, viewport };
}

// Hot-swaps newStream's tracks in as the live outgoing media via
// replaceTrack — no renegotiation, no dropped connection, no new code
// exchange. Callers own stopping whatever track was previously live.
async function swapLiveTrack(newStream) {
  if (!mediaConn || !mediaConn.peerConnection) return;
  const senders = mediaConn.peerConnection.getSenders();
  const videoSender = senders.find((s) => s.track && s.track.kind === "video");
  const audioSender = senders.find((s) => s.track && s.track.kind === "audio");
  const newVideoTrack = newStream.getVideoTracks()[0];
  const newAudioTrack = newStream.getAudioTracks()[0];
  if (videoSender && newVideoTrack) {
    try {
      await videoSender.replaceTrack(newVideoTrack);
    } catch (_e) {
      /* stream will lag until the next successful swap */
    }
  }
  if (audioSender && newAudioTrack) {
    try {
      await audioSender.replaceTrack(newAudioTrack);
    } catch (_e) {}
  }
}

async function beginHostSession(tabId, streamId) {
  currentTabId = tabId;

  let captured;
  try {
    captured = await captureTab(tabId, streamId);
  } catch (e) {
    notifyHost({ type: "session-error", error: "Could not capture the tab: " + e.message });
    return;
  }
  localStream = captured.stream;
  currentViewport = captured.viewport;

  const hostId = randomPeerId();
  peer = new Peer(hostId, { config: { iceServers: self.TABSHARE_RTC_CONFIG.iceServers } });

  peer.on("error", (err) => {
    notifyHost({ type: "session-error", error: "Connection service error: " + (err && err.type ? err.type : err) });
  });

  peer.on("open", (id) => {
    notifyHost({ type: "session-code-ready", code: id });
  });

  // The friend's viewer connects to us first (data channel for input) using
  // the code we showed them. Once that's open we know their peer ID, so we
  // call *them* with our captured stream — no separate step needed.
  peer.on("connection", (conn) => {
    dataConn = conn;
    wireDataConnection();
    conn.on("open", () => {
      notifyHost({ type: "datachannel-open" });
      mediaConn = peer.call(conn.peer, localStream);
      mediaConn.on("error", (err) => {
        notifyHost({ type: "session-error", error: "Video call error: " + err.message });
      });
    });
  });

  startViewportWatcher();
}

// Called when background.js detects the host switched to a different tab in
// a shared *window* (chrome.tabs.onActivated). Re-captures the newly active
// tab and swaps it into the live call via replaceTrack() — no renegotiation,
// no dropped connection, no new code exchange. If the friend hasn't joined
// yet, this just updates what will be sent once they do.
async function switchCapturedTab(newTabId, newStreamId) {
  if (captureBusy) return; // a resize re-capture is mid-flight; don't stomp on it
  captureBusy = true;
  let captured;
  try {
    captured = await captureTab(newTabId, newStreamId);
  } catch (e) {
    notifyHost({ type: "session-error", error: "Couldn't capture that tab: " + e.message });
    captureBusy = false;
    return;
  }

  const oldStream = localStream;
  await swapLiveTrack(captured.stream);
  if (oldStream) {
    oldStream.getTracks().forEach((t) => t.stop());
  }

  localStream = captured.stream;
  currentTabId = newTabId;
  currentViewport = captured.viewport;
  captureBusy = false;

  if (dataConn && dataConn.open) {
    dataConn.send({ type: "viewport-update", width: currentViewport.width, height: currentViewport.height });
  }
}

function wireDataConnection() {
  dataConn.on("data", (msg) => handleInputMessage(msg));
  dataConn.on("close", () => notifyHost({ type: "datachannel-closed" }));
  dataConn.on("error", (err) => {
    notifyHost({ type: "session-error", error: "Data connection error: " + err.message });
  });
}

// If the host resizes their browser window (or changes zoom), the tab's real
// CSS-pixel size changes — and click coordinates are computed from that size,
// so a stale value would make control drift or miss entirely. Poll for that
// as a fallback (this is what catches zoom-level changes, which don't fire a
// window bounds-changed event) — background.js also nudges checkViewportOnce
// immediately when the host's window is resized, so in the common case this
// interval never has to be the one that notices. Always reads the *current*
// tab (not a fixed one captured at start), so this keeps working correctly
// after switchCapturedTab() retargets to a different tab.
function startViewportWatcher() {
  stopViewportWatcher();
  viewportWatcherTimer = setInterval(() => {
    checkViewportOnce();
  }, 1500);
}

function stopViewportWatcher() {
  if (viewportWatcherTimer) clearInterval(viewportWatcherTimer);
  viewportWatcherTimer = null;
}

async function checkViewportOnce() {
  if (!currentTabId || captureBusy) return;
  const vp = await requestViewport(currentTabId);
  if (!vp || !vp.width || !vp.height) return;
  if (!currentViewport || vp.width !== currentViewport.width || vp.height !== currentViewport.height) {
    await applyViewportResize();
  }
}

// Re-captures the current tab at its (now different) real size and hot-swaps
// it into the live call, then tells the friend the new size so both sides
// agree on the same numbers.
//
// Earlier versions tried videoTrack.applyConstraints({ width, height }) to
// re-pin an already-running tab-capture track to a new size in place. That
// doesn't reliably take effect on a live tab-capture track, so the capture —
// and therefore what the friend sees and what clicks are scaled against —
// would silently stay pinned to the tab's *original* size forever, no matter
// how much the host resized. Re-capturing via a fresh getUserMedia() call
// (the same mechanism switchCapturedTab() already uses when following the
// host to a different tab) is what actually works.
async function applyViewportResize() {
  if (!currentTabId || captureBusy) return;
  captureBusy = true;
  const tabId = currentTabId;
  try {
    let captured;
    try {
      // Try capturing the new size while the old stream is still live —
      // smoothest path, if this Chrome version allows overlapping captures
      // of the same tab.
      const streamId = await requestStreamId(tabId);
      captured = await captureTab(tabId, streamId);
    } catch (_e) {
      // Some Chrome versions only allow one active capture per tab at a
      // time. Release the old one and retry once with a fresh stream id.
      if (localStream) localStream.getTracks().forEach((t) => t.stop());
      const retryStreamId = await requestStreamId(tabId);
      captured = await captureTab(tabId, retryStreamId);
    }

    const oldStream = localStream;
    await swapLiveTrack(captured.stream);
    if (oldStream && oldStream !== captured.stream) {
      oldStream.getTracks().forEach((t) => t.stop());
    }

    localStream = captured.stream;
    currentViewport = captured.viewport;

    if (dataConn && dataConn.open) {
      dataConn.send({ type: "viewport-update", width: currentViewport.width, height: currentViewport.height });
    }
  } catch (e) {
    // Both attempts failed (e.g. the tab navigated away mid-resize) — leave
    // whatever's left running and let the host know, rather than silently
    // controlling against stale coordinates.
    notifyHost({ type: "session-error", error: "Lost the shared tab's video after a resize (" + e.message + "). Try restarting the share." });
  } finally {
    captureBusy = false;
  }
}

function requestViewport(tabId) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ target: "background", type: "get-viewport", tabId }, (res) => {
      resolve(res && res.ok ? res.viewport : { width: 1280, height: 800 });
    });
  });
}

function requestStreamId(tabId) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ target: "background", type: "get-stream-id", tabId }, (res) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (res && res.ok) resolve(res.streamId);
      else reject(new Error((res && res.error) || "Could not get a capture stream"));
    });
  });
}

function notifyHost(msg) {
  chrome.runtime.sendMessage({ target: "host", ...msg }).catch(() => {});
}

function cdpMouseType(t) {
  if (t === "mousemove") return "mouseMoved";
  if (t === "mousedown") return "mousePressed";
  if (t === "mouseup") return "mouseReleased";
  if (t === "wheel") return "mouseWheel";
  return "mouseMoved";
}

function handleInputMessage(msg) {
  if (!msg || !currentTabId || !currentViewport) return;

  // Right-click is dispatched into the real, visible host tab via
  // chrome.debugger — it's not confined to what the friend sees, since only
  // the page content is captured, not native browser UI. A right-click there
  // pops Chrome's actual context menu on the host's own screen, which the
  // friend can't see or drive to a sane conclusion (they're flying blind
  // against browser chrome, not the page). Dropping it here, on the host's
  // own side of the wire, blocks it regardless of what the viewer sends.
  if (msg.button === "right") return;

  if (["mousemove", "mousedown", "mouseup", "wheel"].includes(msg.type)) {
    const x = msg.xNorm * currentViewport.width;
    const y = msg.yNorm * currentViewport.height;
    chrome.runtime.sendMessage({
      target: "background",
      type: "dispatch-mouse",
      tabId: currentTabId,
      cdpType: cdpMouseType(msg.type),
      x,
      y,
      button: msg.button,
      clickCount: msg.clickCount,
      deltaX: msg.deltaX,
      deltaY: msg.deltaY
    }).catch(() => {});
  } else if (msg.type === "query-link") {
    // The friend right-clicked; find out (if anything) they're pointing at
    // and hand it back so viewer.js can show a copy-able popup — no real
    // context menu, no new tab, nothing that shows up on the host's screen.
    const x = msg.xNorm * currentViewport.width;
    const y = msg.yNorm * currentViewport.height;
    chrome.runtime.sendMessage(
      { target: "background", type: "get-link-at", tabId: currentTabId, x, y },
      (res) => {
        if (dataConn && dataConn.open) {
          dataConn.send({ type: "link-at-cursor", url: res && res.ok ? res.url : null });
        }
      }
    );
  } else if (msg.type === "keydown" || msg.type === "keyup") {
    chrome.runtime.sendMessage({
      target: "background",
      type: "dispatch-key",
      tabId: currentTabId,
      cdpType: msg.type === "keydown" ? "keyDown" : "keyUp",
      code: msg.code,
      key: msg.key,
      keyCode: msg.keyCode,
      modifiers: msg.modifiers,
      text: msg.text
    }).catch(() => {});
  }
}

function endHostSession() {
  stopViewportWatcher();
  if (dataConn) {
    try {
      dataConn.close();
    } catch (_e) {}
    dataConn = null;
  }
  if (mediaConn) {
    try {
      mediaConn.close();
    } catch (_e) {}
    mediaConn = null;
  }
  if (peer) {
    try {
      peer.destroy();
    } catch (_e) {}
    peer = null;
  }
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  if (currentAudioCtx) {
    try {
      currentAudioCtx.close();
    } catch (_e) {}
    currentAudioCtx = null;
  }
  currentTabId = null;
  currentViewport = null;
  captureBusy = false;
}
