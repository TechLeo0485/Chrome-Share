// Shared WebRTC ICE server configuration.
// Works with `importScripts()` (service worker) and as a plain <script> tag (pages),
// because `self` refers to the global object in both contexts.
//
// Google's public STUN servers handle most home-network NAT traversal for free.
// The Open Relay Project (https://www.metered.ca/tools/openrelay/) is a free public
// TURN relay used as a fallback for stricter NATs (e.g. some mobile/corporate networks),
// since this project intentionally has no dedicated server of its own.
self.TABSHARE_RTC_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    {
      urls: "turn:openrelay.metered.ca:80",
      username: "openrelayproject",
      credential: "openrelayproject"
    },
    {
      urls: "turn:openrelay.metered.ca:443",
      username: "openrelayproject",
      credential: "openrelayproject"
    },
    {
      urls: "turn:openrelay.metered.ca:443?transport=tcp",
      username: "openrelayproject",
      credential: "openrelayproject"
    }
  ]
};
