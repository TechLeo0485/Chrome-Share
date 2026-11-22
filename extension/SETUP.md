# Setup

No Google Cloud account, no API keys, no OAuth, no manual back-and-forth
handshake — connection setup uses [PeerJS](https://peerjs.com)'s free public
broker purely to introduce the two of you; the actual video/control stream
still goes directly peer-to-peer. Setup is just loading the extension.

The extension's ID is fixed at `aiiljjhiojgmdibiegipldhaacjaecfj` (baked into
`manifest.json` via the `key` field) — not required for this version to
work, but keep it as-is anyway (don't hand-edit `manifest.json`'s `key`
field).

## 1. Get the folder to both of you

Zip the whole `extension/` folder (this includes `vendor/peerjs.min.js`, the
bundled signaling library — it needs to ship with the extension since Chrome
extensions can't load remote scripts) and send it to your friend. You'll
each load your own copy.

## 2. Load it in Chrome (both of you, separately)

1. Go to `chrome://extensions`.
2. Turn on **Developer mode** (top right toggle).
3. Click **Load unpacked**, and select the `extension` folder.
4. You should see "TabShare Remote Control" appear with an icon in your
   toolbar.

That's it — no accounts, no keys, nothing else to configure.

## 3. First run

- **You:** click the toolbar icon and choose a mode:
  - **One tab** — switch to the tab you want to share (e.g. Gmail) *before*
    clicking the icon, since Chrome only authorizes whichever tab was
    active at that moment.
  - **Whole window** — shares your current window, starting with your
    current tab (there's no picker for a different window — Chrome only
    ever authorizes the tab active when you click the icon, so it wouldn't
    work anyway). To switch which tab your friend sees, make the new tab
    active and click the toolbar icon again — it'll show a **"Continue
    sharing with this tab"** button (this one extra click per switch is a
    hard Chrome requirement, not something this extension can skip). They
    can't switch tabs or use the address bar themselves either way (see
    README's limitations section for why).
- Click **Start sharing**. A new tab opens and shows a short code once
  capture starts (looks like `tabshare-a1b2c3...`).
- Copy that code and send it to your friend through whatever chat app you
  already use.
- **Your friend:** clicks their toolbar icon → **Join a friend's share** →
  types their name (optional) → pastes your code → **Join**.
- **You:** your sharing page shows "*Name* wants to join" — click **Allow**.
  (The toolbar icon shows a badge while a request is waiting; unanswered
  requests expire after 90 seconds.)
- That's it — they're connected. If their connection drops, they reconnect
  automatically with no new prompt. Untick "Allow them to control this tab"
  any time for view-only.

**Code won't connect at all?** On the sharing page, open **Connect
manually**, create an invite and send it; your friend pastes it in the
viewer's **Manual** tab and sends back the reply code; paste that and click
**Connect**. No server needed.

Each code is single-use, tied to that one sharing session. If you click
Stop and Start again, you'll get a fresh code — the old one stops working.

## Troubleshooting

- **"That code isn't an active session right now"** — either the code was
  mistyped/truncated, or the host isn't actively sharing anymore (they
  clicked Stop, closed the tab, or the code is from an old session).
- **Stuck on "Connecting…"** — likely a restrictive network on one side
  (corporate/school firewall) preventing the peer-to-peer connection or the
  initial broker handshake. The viewer retries automatically for a few
  minutes. If it never connects, one of you can add a free-tier TURN server
  in **Connection settings** (link in the popup and on the viewer's join
  screen) — use its **Test** button to confirm it works. Trying from a home
  network also usually helps.
- **"Connection lost — reconnecting…"** — the link dropped; the viewer
  rejoins the same code on its own. If it keeps happening, it's usually a
  weak or restrictive network — a TURN server (above) helps.
- **Video briefly freezes/blinks when switching tabs in window mode** —
  expected; each switch re-captures the newly active tab, which takes a
  fraction of a second.
- **Friend can't switch tabs or type in the address bar in window mode** —
  expected, not a bug. See the README's limitations section.
