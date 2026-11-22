// Prefer the most bandwidth-efficient video codec both Chromes support.
//
// By default Chrome negotiates VP8. For screen-like content (pages, text),
// VP9 typically needs noticeably less bandwidth for the same sharpness, and
// AV1 even less (at more CPU cost, so it's second choice). H.264 comes next
// because it's often hardware-accelerated; VP8 is the last resort.
//
// PeerJS creates its offers/answers internally, so rather than patching the
// library we hook RTCPeerConnection.createOffer/createAnswer on this page:
// right before either runs, video transceivers get the preferred codec order.
// This covers the PeerJS path and the manual (no-server) path alike. Loaded
// by offscreen.html (host) and viewer.html (friend) before anything else.

(function () {
  const RANK = { "video/vp9": 0, "video/av1": 1, "video/h264": 2, "video/vp8": 3 };
  const rankOf = (codec) => {
    const r = RANK[String(codec.mimeType).toLowerCase()];
    return r === undefined ? 10 : r; // rtx / red / ulpfec etc. keep their place after the real codecs
  };

  function sortedVideoCodecs(source) {
    const caps = source && source.getCapabilities && source.getCapabilities("video");
    if (!caps || !caps.codecs || !caps.codecs.length) return null;
    // Array.prototype.sort is stable, so Chrome's own order (e.g. VP9
    // profile 0 before profile 2) is kept within each codec family.
    return caps.codecs.slice().sort((a, b) => rankOf(a) - rankOf(b));
  }

  function preferEfficientCodecs(pc) {
    if (typeof RTCRtpTransceiver === "undefined" || !RTCRtpTransceiver.prototype.setCodecPreferences) return;
    let transceivers;
    try {
      transceivers = pc.getTransceivers();
    } catch (_e) {
      return;
    }
    for (const t of transceivers) {
      const kind = t.receiver && t.receiver.track && t.receiver.track.kind;
      if (kind !== "video" || t.stopped) continue;
      // The spec validates against receiver capabilities; older Chrome
      // versions against sender ones — try both, and never break the call.
      for (const source of [window.RTCRtpReceiver, window.RTCRtpSender]) {
        const codecs = sortedVideoCodecs(source);
        if (!codecs) continue;
        try {
          t.setCodecPreferences(codecs);
          break;
        } catch (_e) {
          /* try the next capability source */
        }
      }
    }
  }

  const proto = RTCPeerConnection.prototype;
  const origOffer = proto.createOffer;
  const origAnswer = proto.createAnswer;
  proto.createOffer = function (...args) {
    preferEfficientCodecs(this);
    return origOffer.apply(this, args);
  };
  proto.createAnswer = function (...args) {
    preferEfficientCodecs(this);
    return origAnswer.apply(this, args);
  };
})();
