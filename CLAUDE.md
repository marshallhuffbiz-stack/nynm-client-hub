# Client Hub / Relay — project rules

What this is: client request portal (`portal/`) + Marshall's Request Desk (`desk/`) + a headless-Claude drain worker, on a Google Sheet-as-queue behind an Apps Script API. Repo: `nynm-client-hub` on GitHub; frontends deploy via GitHub Pages.

## Gotchas that keep getting re-learned

- **The production backend is a STANDALONE Apps Script named "Untitled" — it is NOT bound to the Sheet.** Don't hunt for it inside the spreadsheet. Deploy flow: `apps-script/DEPLOY-V9.md` (Code.gs is the source of truth here; paste + new deployment version).
- **POSTs must use `Content-Type: text/plain`** — anything else trips Apps Script CORS.
- **Access tokens ride the URL**: Desk uses `?k=`, Portal uses `?c=` (older links `?client=`). The PWA manifests deliberately **omit `start_url`/`scope`** so Add-to-Home-Screen keeps the token — do not add those keys back (iOS dead-ends clients if you do).
- **The worker runs on the VPS** (systemd, 90s interval, user `relay`) since 2026-07-02. The Mac launchd worker is RETIRED — the plist in the repo is rollback material only. Brand assets sync Mac→VPS hourly.
- Cache-bust live checks with `?cb=<timestamp>` — GH Pages and the service worker both cache hard (stale-while-revalidate; first paint comes from cache).
- Nothing ships without Marshall's approval in the Desk, EXCEPT the explicitly config-gated auto lanes: `autoApproveCancelPosts`, `autoApproveDaily`, client-review approve (portal), and the `autoPublishFallback` lane (2026-07-22: a post/event-promo request with no human action for 60 min auto-sends to the drain and auto-approves once staged — Marshall's standing order because he keeps missing notify pings). Website/design fixes are still staged, never auto-pushed.

## Verifying changes

`npm test` runs the core suite. For frontend changes, test against the mock server (`npm run seed && npm run dev`) before touching live; live checks go against the GH Pages URL with a real `?k=`/`?c=` token plus `?cb=`.
