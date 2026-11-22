// Shared WebRTC ICE server configuration.
// Works with `importScripts()` (service worker) and as a plain <script> tag (pages),
// because `self` refers to the global object in both contexts.
//
// STUN servers (free, no account) let the two Chromes discover their public
// addresses so they can connect directly. Several independent providers are
// listed so one being blocked or down doesn't break anything:
//  - Google: fast almost everywhere, but blocked in mainland China.
//  - Cloudflare: global anycast, generally reachable from China too.
//  - Xiaomi (stun.miwifi.com): hosted in China, for hosts/viewers there.
//
// There is deliberately NO built-in TURN relay. The free public one this used
// to ship with (openrelay.metered.ca) has been shut down — its DNS now points
// at a reserved non-routable address — and there is no other free relay that
// works without an account. Users on very restrictive networks (strict NAT,
// carrier-grade NAT on mobile data, corporate firewalls) can add their own
// free-tier TURN account in the extension's Connection settings page; it's
// merged in by buildIceServers() below. Only ONE of the two people needs a
// working TURN entry for a relayed connection to succeed.
self.TABSHARE_DEFAULT_ICE_SERVERS = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.miwifi.com:3478" }
];

// chrome.storage.local key holding the user's own TURN server, if any:
// { urls: string[], username: string, credential: string }
self.TABSHARE_TURN_STORAGE_KEY = "customTurnServer";

// Returns the full iceServers list: built-in STUN plus the user's own TURN
// server (if they've configured one in settings).
self.TABSHARE_buildIceServers = function (customTurn) {
  const list = self.TABSHARE_DEFAULT_ICE_SERVERS.slice();
  if (customTurn && Array.isArray(customTurn.urls) && customTurn.urls.length) {
    list.push({
      urls: customTurn.urls,
      username: customTurn.username || "",
      credential: customTurn.credential || ""
    });
  }
  return list;
};

// Convenience for extension pages / the service worker (not the offscreen
// document, which has no chrome.storage access — background.js passes the
// list to it instead).
self.TABSHARE_loadIceServers = async function () {
  let customTurn = null;
  try {
    const stored = await chrome.storage.local.get(self.TABSHARE_TURN_STORAGE_KEY);
    customTurn = stored[self.TABSHARE_TURN_STORAGE_KEY] || null;
  } catch (_e) {}
  return self.TABSHARE_buildIceServers(customTurn);
};
