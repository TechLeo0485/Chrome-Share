const params = new URLSearchParams(location.search);
const mode = params.get("mode") === "window" ? "window" : "tab";
const tabId = Number(params.get("tabId"));
const windowId = Number(params.get("windowId"));

const statusEl = document.getElementById("status");
const step1 = document.getElementById("step1");
const codeBox = document.getElementById("codeBox");
const copyCodeBtn = document.getElementById("copyCodeBtn");
const stopBtn = document.getElementById("stopBtn");
const nowSharingEl = document.getElementById("nowSharing");
const switchHintEl = document.getElementById("switchHint");

let currentCode = "";
let connected = false;

if (mode === "window" && switchHintEl) {
  switchHintEl.style.display = "block";
}

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = cls || "";
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
  if (!msg || msg.target !== "host") return;

  switch (msg.type) {
    case "session-code-ready":
      // Also fires again (same code) after recovering from a broker drop.
      currentCode = msg.code;
      codeBox.textContent = msg.code;
      step1.style.display = "block";
      if (connected) {
        setStatus("Connected — your friend is now in control.", "connected");
      } else {
        setStatus("Send the code above to your friend. It'll connect automatically once they join.");
      }
      break;
    case "broker-reconnecting":
      if (connected) {
        setStatus("Connected — your friend is in control. (Code service briefly unreachable; retrying in the background — this session isn't affected.)", "connected");
      } else {
        setStatus("Can't reach the connection service right now — retrying automatically. Your code stays the same.", "error");
      }
      break;
    case "datachannel-open":
      connected = true;
      setStatus("Connected — your friend is now in control.", "connected");
      break;
    case "datachannel-closed":
      connected = false;
      setStatus("Your friend's connection dropped. Their viewer reconnects automatically — or they can rejoin with the same code.");
      break;
    case "now-sharing-tab":
      if (nowSharingEl) {
        nowSharingEl.textContent = msg.title ? "Currently sharing: " + msg.title : "";
      }
      break;
    case "session-error":
      setStatus(msg.error, "error");
      break;
    case "sharing-stopped":
      setStatus("Sharing stopped (" + (msg.reason || "") + ").");
      step1.style.display = "none";
      break;
  }
});

copyCodeBtn.addEventListener("click", async () => {
  if (!currentCode) return;
  await navigator.clipboard.writeText(currentCode);
  copyCodeBtn.textContent = "Copied!";
  setTimeout(() => (copyCodeBtn.textContent = "Copy code"), 1500);
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
