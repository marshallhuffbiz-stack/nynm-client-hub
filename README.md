# Client Hub

A unified intake portal for NYNM clients + an internal ops hub for Marshall. Replaces the "client texts me → I screenshot it → I feed it to a system" loop with: **client submits a structured request → it lands in one queue → one tap fires Claude to build a draft → Marshall approves → it ships.**

Modeled on the proven `lead-responder` architecture (Google Sheet + Apps Script API + launchd worker + static PWAs), but a fully separate system.

## What's here

| Path | What it is |
|---|---|
| `portal/` | **Client Portal** PWA — clients submit posts / website fixes / designs / events with photos, see status. Secret link per client. |
| `desk/` | **Request Desk** PWA — Marshall's queue across all clients: comment + Send to Claude, review staged drafts, Approve / Request changes, promote events. |
| `core/` | Pure domain logic (validation, stage machine, skill routing, merge) — TDD'd. |
| `mock-server/` | Local Node backend mirroring the Apps Script contract (for dev + the working demo). |
| `apps-script/` | The production backend (`Code.gs`) — same contract, Google Sheet-backed. |
| `worker/` | launchd poller + headless-Claude drain + notifications. |
| `shared/` | `config.js` (the one-line mock↔live swap), `api.js` (browser client), `ui.css` (NYNM tokens). |
| `scripts/` | `seed.mjs` (pilot data), `dev.mjs` (run it all locally). |
| `docs/superpowers/specs/` | The full design spec. |

## Quick start (local, no Google needed)

```bash
npm run seed && npm run dev
# Desk:   http://127.0.0.1:8080/desk/?k=dev-admin
# Portal: http://127.0.0.1:8080/portal/?c=dev-the-o
npm test
```

## Request lifecycle

```
submitted ─(Send to Claude)→ queued ─(worker)→ drafting → ready ─(Approve)→ approved ─(worker)→ shipping → done
                                                            └─(Request changes)→ changes ─(worker)→ drafting → …
```
Nothing ships without Marshall's approval. Website/design fixes are prepared for approval, never auto-pushed live.

## Going live
See **[SETUP.md](SETUP.md)** — create the Sheet, deploy the Apps Script, flip `shared/config.js` to live, host the pages, install the worker.

## Website changes: the site lane on the VPS

An approved `website` request is applied by `worker/site-apply.mjs`: commit only
the drafted files into that client's checkout, push `main`, run the site's
`deploy.steps` (build, then `wrangler pages deploy`), then poll the live URL
until the change is on it. No client site is git-connected on Cloudflare
Pages, so the deploy steps are what puts a change live; without them a push
changes nothing and the request would sit at "pushed but not confirmed live".

Checkouts live under `/home/relay/sites/` (Eats at `/home/relay/Eats On 601
Website`), one write deploy key per repo in `/home/relay/.ssh/`, and the map
of sites in `worker/config.json` (`sites.<clientId>.deploy`). The Cloudflare
credentials come from `config.cloudflare`, written by
`scripts/cf-token-setup.sh`, and reach wrangler only through the environment.
The schedule lane (`schedule-sync.mjs`) runs the same deploy steps after its
push. Adding a site: repo on GitHub, deploy key, clone as `relay`, prove the
build as `relay`, add the `sites` entry, then ship one real request.

## Status
Built 2026-06-16. Local system is complete and browser-verified (27 tests green). Production wiring (Google Sheet / deploy / Postiz channels / public host / worker install) is the deferred checklist in SETUP.md — it needs Marshall's accounts.
