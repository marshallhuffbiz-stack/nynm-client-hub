# Relay — Approve → Auto-Publish

**Date:** 2026-06-19
**Status:** Approved (Marshall, 2026-06-19)

## Problem

When Marshall taps **Approve** on a drafted post in the Relay Desk, nothing publishes. The
request moves `ready → approved`, the worker picks it up as a "ship" job, but the headless
Claude drain has `Skill(post)` denied, so shipping dead-ends in `error` with
*"post skill denied in headless mode — draft is ready, needs manual publish via /post."*
Every approved post then requires a manual `/post`. Marshall wants approval itself to publish.

## Approach

Publishing an already-approved draft is **mechanical, not creative** — take the caption +
graphic + the client's channels, upload, post, mark done. So it runs as **plain deterministic
Node inside the worker poller**, NOT through the headless Claude drain.

- `Skill(post)` **stays denied** in `worker/claude-settings.json`. The safety model is unchanged:
  the only thing that ever publishes is an item Marshall explicitly approved on the Desk.
- Rejected alternative: re-enable `Skill(post)` in the drain. The `post` skill is interactive
  (asks 4 questions, waits for confirmation) and would stall in headless `-p` mode. A Node
  module is more reliable and fully unit-testable.

## Components

### 1. `worker/publish.mjs` (new)

Pure orchestration with all I/O injected, so the logic is unit-testable.

- `resolveChannels(integrations, clientName)` → the client's connected, enabled Postiz
  integrations, **sorted Facebook-first then Instagram** (so the stagger publishes FB before IG).
- `publishTimes(count, { scheduledFor, now, leadMin=3, staggerMin=6 })` → array of ISO strings.
  Base time = `scheduledFor` if set and in the future, else `now + leadMin`. Each subsequent
  channel is staggered `+staggerMin` minutes (the anti-burst rule — never two channels the same
  minute).
- `shipRequest(req, { client, integrations, postiz, now })` → resolves channels, picks the media
  (the locally-rendered `draft.artifactPath`, uploaded to Postiz; falls back to a direct
  `draft.imageUrl` only if it is already an `http(s)`/`data` URL), computes times, and calls
  `postiz.createPost(...)` once per channel. Returns
  `{ ok:true, channels:[...], postIds:[{channel, integrationId, postId, at}] }`
  or `{ ok:false, error }` (no channels connected, missing media, or a Postiz failure).
- `makeShipper({ fetchIntegrations, postiz, apiUpdate, notifier, now, repoRoot })` → the impure
  wrapper used by the poller. For each ship job: `apiUpdate(action:"ship")` (approved→shipping)
  → `shipRequest(...)` → on success `apiUpdate(action:"done", meta.run)` + `notifier.notifyShipped`;
  on failure `apiUpdate(action:"error", meta.run)` + `notifier.notifyShipFailed`.
- `makePostizClient()` → real adapter that shells out to the proven
  `~/.claude/skills/post/scripts/postiz.sh` (`integrations:list`, `upload`, `posts:create`
  with `--settings '{"post_type":"post"}'`). Not unit-tested (pure I/O); exercised in live verify.

### 2. `worker/poller.mjs` (edit)

`runOnce` splits the work: `drafts` → the Claude `drainer` (creative), `ships` → the new injected
`shipper` (mechanical). Pass `all.clients` to the shipper so it can resolve the client name.
The CLI entry constructs `shipper: makeShipper({ ... makePostizClient(), apiUpdate, makeNotifier(cfg) ... })`.
`spawnClaudeDrain` writes only `drafts` into the drain brief.

### 3. `worker/drain.md` (edit)

Drop the now-dead "ship via the post skill" instructions; the drain **drafts only**. Publishing
is the poller's deterministic job.

### 4. `worker/notify.mjs` (edit)

Add `notifyShipped({ req, channels })` ("Published … to Facebook + Instagram") and
`notifyShipFailed({ req, error })`.

## Data flow

```
Desk: Approve  →  stage: approved
worker tick    →  detectJobs → ships:[req]
shipper        →  apiUpdate(action:"ship")        stage: shipping  ("Publishing…")
               →  resolve channels (FB, IG) for the client
               →  upload worker/out/<id>/post.png → Postiz URL
               →  createPost FB @ now+3m, IG @ now+9m  (staggered)
               →  apiUpdate(action:"done", meta.run.postIds)   stage: done ✅
(on any failure → apiUpdate(action:"error")  stage: error + notify)
```

## Channel resolution

`postizChannels` on the client record is currently empty for all clients, so channels are
resolved **dynamically at ship time**: list Postiz integrations and match
`integration.customer.name === client.name` (e.g. "Eats on 601"). This is exactly what worked for
the manual food-truck publish. No stored state to drift.

## Timing

`scheduledFor` from the draft if set and in the future; otherwise publish now (`now + 3 min`).
Multiple channels staggered 6 min apart, Facebook first.

## Failure handling & idempotency

- The request is flipped to `shipping` **before** the Postiz call. `detectJobs` only picks
  `approved` for ships, so a mid-publish crash leaves it in `shipping` and it is never
  re-published (no double-post). A stuck `shipping` is a rare manual-retry case.
- A Postiz rejection → `error` ("Needs attention" + `notifyShipFailed`). The VPS
  `postiz-guardian` already auto-retries transient Meta errors once, so most blips self-heal.

## Testing

Unit (node:test, injected deps):
- `resolveChannels`: filters by client name, drops disabled, FB-before-IG ordering, empty result.
- `publishTimes`: future `scheduledFor` honored; past/empty → `now+lead`; stagger spacing; count.
- `shipRequest`: happy path (upload + N createPost calls with right times/integrations);
  no-channels → `{ok:false}`; missing media → `{ok:false}`; a createPost throw → `{ok:false}`.
- `makeShipper`: success path writes ship→done with postIds + notifies; failure path writes
  ship→error + notifies; resolves client by `clientId`.
- Update `poller.test.mjs`: drainer handles drafts only; a new shipper stub ships `approved → done`.

Live verify (no public spam): exercise the real Postiz client against a throwaway request in
**draft** mode (or schedule + immediately delete) to prove resolve→upload→create wiring, then
confirm `npm test` is green and `Skill(post)` is still denied.

## Out of scope

No client-side approvals (deferred). No change to drafting. No re-enabling outward skills in the
headless worker. No GitHub Pages deploy (worker runs local files; changes take effect next tick).
