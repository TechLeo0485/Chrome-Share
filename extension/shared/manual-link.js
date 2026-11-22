// Manual ("no server") connection helpers, shared by offscreen.js (host) and
// viewer.js (friend).
//
// Normal sessions use PeerJS's free public broker to exchange the WebRTC
// handshake automatically. If that broker is down or blocked (it can be
// unreachable from some countries/networks), the two people can exchange the
// handshake themselves instead: the host sends a long "invite" code, the
// friend sends back a "reply" code — through any chat app — and the
// connection is made directly, with no server involved at all.
//
// Codes are the SDP description (with all ICE candidates already gathered),
// deflate-compressed and base64url-encoded, prefixed with a version tag.

(function () {
  const PREFIX_OFFER = "TSI1."; // host's invite
  const PREFIX_ANSWER = "TSR1."; // friend's reply

  function toBase64Url(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function fromBase64Url(str) {
    const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  async function pipeThrough(bytes, transform) {
    const stream = new Blob([bytes]).stream().pipeThrough(transform);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function encode(description) {
    const prefix = description.type === "offer" ? PREFIX_OFFER : PREFIX_ANSWER;
    const json = new TextEncoder().encode(description.sdp);
    const packed = await pipeThrough(json, new CompressionStream("deflate-raw"));
    return prefix + toBase64Url(packed);
  }

  // expectType: "offer" | "answer". Throws a user-readable Error on bad input.
  async function decode(code, expectType) {
    const clean = String(code || "").replace(/\s+/g, "");
    const prefix = expectType === "offer" ? PREFIX_OFFER : PREFIX_ANSWER;
    if (!clean.startsWith(prefix)) {
      if (clean.startsWith(PREFIX_OFFER) || clean.startsWith(PREFIX_ANSWER)) {
        throw new Error(
          expectType === "offer"
            ? "That's a reply code — paste the invite code your friend sent you."
            : "That's an invite code — paste the reply code your friend sent back."
        );
      }
      throw new Error("That doesn't look like a TabShare manual code. Make sure you copied all of it.");
    }
    try {
      const bytes = await pipeThrough(fromBase64Url(clean.slice(prefix.length)), new DecompressionStream("deflate-raw"));
      return { type: expectType, sdp: new TextDecoder().decode(bytes) };
    } catch (_e) {
      throw new Error("That code is incomplete or damaged — copy the whole thing and try again.");
    }
  }

  // Resolves once ICE gathering is complete (so the code contains every
  // candidate), or after timeoutMs with whatever has been gathered so far.
  function waitForIceGathering(pc, timeoutMs) {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        pc.removeEventListener("icegatheringstatechange", check);
        clearTimeout(timer);
        resolve();
      };
      const check = () => {
        if (pc.iceGatheringState === "complete") done();
      };
      const timer = setTimeout(done, timeoutMs || 6000);
      pc.addEventListener("icegatheringstatechange", check);
    });
  }

  // Wraps a raw RTCDataChannel in the small subset of PeerJS's DataConnection
  // API that offscreen.js / viewer.js use (open, send, on, close,
  // dataChannel), so the rest of the code doesn't care which path connected.
  function wrapChannel(channel) {
    const handlers = {};
    const emit = (event, arg) => (handlers[event] || []).slice().forEach((fn) => fn(arg));
    const conn = {
      peer: "manual",
      dataChannel: channel,
      get open() {
        return channel.readyState === "open";
      },
      send(obj) {
        channel.send(JSON.stringify(obj));
      },
      on(event, fn) {
        (handlers[event] = handlers[event] || []).push(fn);
        return conn;
      },
      close() {
        try {
          channel.close();
        } catch (_e) {}
      }
    };
    channel.addEventListener("open", () => emit("open"));
    channel.addEventListener("close", () => emit("close"));
    channel.addEventListener("error", () => emit("error", new Error("data channel error")));
    channel.addEventListener("message", (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch (_e) {
        return;
      }
      emit("data", msg);
    });
    return conn;
  }

  self.TabshareManual = { encode, decode, waitForIceGathering, wrapChannel };
})();
