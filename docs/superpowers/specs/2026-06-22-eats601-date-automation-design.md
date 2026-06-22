# Eats on 601 — dated request → website + day-of post

**Date:** 2026-06-22
**Status:** Design approved (Marshall, 2026-06-22)

## Goal
When an Eats on 601 request **names a date** (or a calendar event is added), the worker
automatically (1) puts the vendor/event on the website's "Coming up on the lot" section and
(2) **fully-automatically** schedules a day-of post for **8:00 AM ET**, no approval gate.

## Approved decisions
- **Trigger:** any Eats on 601 request that names a date (+ calendar events). Date parsed by Opus.
- **Post:** fully automatic — no approval. 8:00 AM ET on the event day. FB + IG.
- **Website:** the existing Astro site `marshallhuffbiz-stack/eats-on-601-site`
  (`/Users/MarshallHuff/Eats On 601 Website`), Cloudflare Pages, auto-deploys on push to `main`.
  "Coming up" is driven by `src/content/events.json` and auto-hides past events.
- **Safety nets:** confidence gate (skip if the date is ambiguous), heads-up notifications when
  it acts, cancelable Postiz window (scheduled, not instant), idempotent.

## Two outputs, one trigger
```
Eats-on-601 request names a date
  → extract {title/vendor, isoDate, time, kind} via Opus (confidence-gated)
  → if NOT confident → skip automation, fall back to the normal draft-for-Marshall flow
  → if confident + not already processed (idempotency key):
       B1 website: upsert events.json entry → commit + push eats-on-601-site → Pages deploys
       B2 post:   create event-promo, auto-draft (Opus), AUTO-ship scheduledFor = day 08:00 ET
       mark the original request handled + notify Marshall (site updated / post scheduled)
```

## Modules

### `worker/events-auto.mjs` (new, pure — TDD)
- `slugify(s)` — id-safe slug.
- `eventKey(clientId, isoDate, title)` — stable idempotency key.
- `etOffset(ymd)` / `etIso(ymd, hhmmss)` — America/New_York offset (EDT/EST via US DST rule) and
  an ISO timestamp; `dayOfPostIso(ymd)` = `etIso(ymd, "08:00:00")`.
- `isConfident(extracted)` — gate: has a valid future isoDate + a title.
- `buildSiteEvent(extracted)` — an events.json entry `{ id, kind, date (display "Sat · Jun 28"),
  isoDate, title, description, meta }` (kind `vendor-day` for a truck, `event` for a lot event).
- `mergeSiteEvents(existing, entry)` — upsert by id (replace if present, else append); idempotent.

### `worker/site-sync.mjs` (new, impure — injected git/fs, exercised in live verify)
- `syncSiteEvent({ siteDir, entry, git })` — read events.json, `mergeSiteEvents`, write, `git add/commit/push`
  (pull --rebase first to avoid conflicts with Marshall's local edits). Returns `{ ok, pushed, deployUrl }`.

### Extraction (impure — injected, fake in tests)
- `extractEvent(requestText)` → `{ hasDate, confident, title, isoDate, timeStart, timeEnd, kind, vendor, description }`
  via a headless Opus call (reuse the drain's `claude -p` with a tight JSON prompt). Confidence-gated.

### `worker/poller.mjs` integration
- New lane: for Eats-on-601 `post`/`event-promo`/`design`/event submissions that name a date and
  aren't yet processed → run the automation (site-sync + auto day-of post). Keep it isolated and
  idempotent; mark processed in the request meta (`meta.autoEvent = { key, siteAt, postAt }`).
- **Auto-publish without approval:** the auto-created day-of post is drafted then advanced
  `approved → ship` by the worker itself (an `auto: true` ship), scheduled for 08:00 ET day-of via
  the existing deterministic ship path (`publishTimes` honors a future `scheduledFor`).

## Safety / guardrails
- Confidence gate; ambiguous/no date → no automation (normal flow).
- Idempotency key prevents double site entries / double posts.
- Heads-up notifications (`notifyShipped`-style) when the site updates and when a post is scheduled.
- The post is *scheduled* (8 AM day-of), so it's visible + cancelable in Postiz until then.
- Site push does `pull --rebase` and commits only `events.json`/`vendors.json` to avoid clobbering
  Marshall's working copy; CI (tests + build) gates the deploy, so a bad entry won't ship.

## Testing
Pure (`events-auto`): slugify, eventKey, ET offset across DST boundary, dayOfPostIso, isConfident
(future/past/missing), buildSiteEvent (vendor-day vs event), mergeSiteEvents upsert. Impure
(site-sync, extraction, poller lane): injected fakes. Live verify after: a real dated test request →
site PR/commit (dry first), and a scheduled (cancelable) day-of post.

## Out of scope
Other clients (Eats on 601 only for now — name/site specific). No new site UI (reuses the existing
events collection). No change to the approval gate for normal (non-dated) posts.
