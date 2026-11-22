// Connection settings: lets the user add their own (e.g. free-tier) TURN
// server. Stored in chrome.storage.local under TABSHARE_TURN_STORAGE_KEY and
// merged into the ICE server list by shared/rtc-config.js on both the host
// (via background.js → offscreen.js) and the viewer.

const KEY = self.TABSHARE_TURN_STORAGE_KEY;
const urlsEl = document.getElementById("urls");
const usernameEl = document.getElementById("username");
const credentialEl = document.getElementById("credential");
const statusEl = document.getElementById("status");

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = cls || "";
}

function readForm() {
  const urls = urlsEl.value
    .split(/[\s,]+/)
    .map((u) => u.trim())
    .filter(Boolean);
  return { urls, username: usernameEl.value.trim(), credential: credentialEl.value };
}

function validate(turn) {
  if (!turn.urls.length) return "Enter at least one TURN URL.";
  const bad = turn.urls.find((u) => !/^turns?:[^\s]+$/i.test(u));
  if (bad) return 'Not a TURN URL: "' + bad + '" — it should start with turn: or turns:';
  if (!turn.username || !turn.credential) return "TURN servers need both a username and a password.";
  return null;
}

async function load() {
  const stored = await chrome.storage.local.get(KEY);
  const turn = stored[KEY];
  if (turn) {
    urlsEl.value = (turn.urls || []).join("\n");
    usernameEl.value = turn.username || "";
    credentialEl.value = turn.credential || "";
    setStatus("A TURN server is saved and will be used for new sessions.", "muted");
  } else {
    setStatus("No TURN server saved — using direct connections only.", "muted");
  }
}

document.getElementById("saveBtn").addEventListener("click", async () => {
  const turn = readForm();
  const problem = validate(turn);
  if (problem) {
    setStatus(problem, "error");
    return;
  }
  await chrome.storage.local.set({ [KEY]: turn });
  setStatus("Saved. It will be used for your next share or join. Tip: click Test to check it works.", "ok");
});

document.getElementById("clearBtn").addEventListener("click", async () => {
  await chrome.storage.local.remove(KEY);
  urlsEl.value = "";
  usernameEl.value = "";
  credentialEl.value = "";
  setStatus("Removed. Using direct connections only.", "muted");
});

// Asks the browser to gather ICE candidates using ONLY this TURN server. If
// we get a "relay" candidate, the server accepted the credentials and can
// relay traffic for us.
document.getElementById("testBtn").addEventListener("click", async () => {
  const turn = readForm();
  const problem = validate(turn);
  if (problem) {
    setStatus(problem, "error");
    return;
  }
  setStatus("Testing… (up to 10 seconds)", "muted");
  const result = await testTurn(turn);
  if (result.ok) {
    setStatus("Works — the TURN server gave a relay address" + (result.proto ? " (" + result.proto + ")" : "") + ". Don't forget to Save.", "ok");
  } else {
    setStatus(
      "No relay address received. Check the URL, username and password (free-tier credentials sometimes expire), or try a :443 / transport=tcp URL.",
      "error"
    );
  }
});

function testTurn(turn) {
  return new Promise((resolve) => {
    let pc;
    try {
      pc = new RTCPeerConnection({
        iceServers: [{ urls: turn.urls, username: turn.username, credential: turn.credential }],
        iceTransportPolicy: "relay"
      });
    } catch (_e) {
      resolve({ ok: false });
      return;
    }
    let done = false;
    const finish = (res) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        pc.close();
      } catch (_e) {}
      resolve(res);
    };
    const timer = setTimeout(() => finish({ ok: false }), 10000);
    pc.onicecandidate = (e) => {
      if (!e.candidate) {
        finish({ ok: false }); // gathering finished with no relay candidate
        return;
      }
      if (e.candidate.type === "relay" || / typ relay /.test(e.candidate.candidate)) {
        finish({ ok: true, proto: e.candidate.relayProtocol || "" });
      }
    };
    pc.createDataChannel("turn-test");
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .catch(() => finish({ ok: false }));
  });
}

load();
