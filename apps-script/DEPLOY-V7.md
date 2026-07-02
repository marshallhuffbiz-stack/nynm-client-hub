# Deploy checklist — Apps Script Version 7

Code batch prepared 2026-07-01 in the `client-hub-auto` worktree. Live backend is
still **Version 6** — nothing below is live until you redeploy. All behavior is
pinned by `test/contract.test.mjs` against the mock (149 tests green); Code.gs
carries the identical hand-ported logic (marked with `[V7]` comments).

## What changed (V6 → V7)

1. **endTime persistence** — `time`/`endTime` columns, validation, and the
   `COLS_EVENTS` header self-migration were already in this Code.gs (landed
   2026-07-01) but are dark in prod; V7 ships them. Every event added since the
   portal's end-time field went live has been silently losing its end time.
2. **promoteEvent carries times** — the event-promo request description now
   includes the times in 12-hour form: `Karaoke on 2026-07-11, 7:00 PM–10:00 PM.
   prizes for best duet` (or `, starting 7:00 PM` when there is no end time), so
   drafts stop guessing.
3. **Server-side meta deep-merge** — `updateRequest` patches that carry `meta`
   now MERGE instead of clobbering: `thread`/`activity` union-append (deduped,
   sorted by timestamp), nested objects like `run` shallow-merge, scalars
   overwrite. Thread messages, activity entries, `notified`, and
   `clientRequestId` can no longer be wiped by a stale worker writeback.
4. **First-class `requeue` action** — `patch.action = "requeue"` is legal only
   from `error`/`shipping`. Publish-phase failure with a draft → back to
   `approved` **keeping the draft** (no re-drafting run burned); anything else →
   `queued` with draft cleared. Clears `meta.run.error`, writes an activity
   entry. (The Desk's Retry currently patches `stage` manually — it keeps
   working, but should move to `action:"requeue"` in a follow-up.)

Untouched: tenant spoof-block (forced clientId), 413 upload guard, PIN gate,
constant-time admin-token compare, all existing transitions.

## How to redeploy as Version 7

1. Open the Apps Script project bound to the Client Hub sheet
   (`13doR_3WcCSzsGBa6Emd5zHnMiY7leDyJrkJaT0Zoew0`).
2. Replace the entire `Code.gs` contents with this worktree's
   `apps-script/Code.gs` (select-all → paste). `appsscript.json` is unchanged.
3. Save, then **Deploy → Manage deployments → edit the existing deployment →
   Version: New version** (this becomes Version 7) → Deploy. Do NOT create a new
   deployment — that would change the /exec URL the portal, Desk, and worker use.
4. First request after deploy self-migrates the Events header row (adds
   `time`/`endTime` columns). No manual sheet edit needed.

## One-line verification per feature (against the live /exec URL)

- **endTime round-trip:** add an event in the portal with start + end times, then
  `curl '<EXEC_URL>?admin=<TOKEN>'` and confirm the new event row has
  `"endTime":"22:00"` (also visible as a filled `endTime` cell in the Events tab).
- **promoteEvent times:** promote that event from the Desk and confirm the new
  request's `description` contains `7:00 PM–10:00 PM`.
- **meta merge:** post a client message on any request, then hit Retry (or any
  worker writeback) and confirm the message is still in `meta.thread` afterwards.
- **requeue:** on a publish-errored request, POST
  `{"admin":"<TOKEN>","action":"updateRequest","id":"<req>","patch":{"action":"requeue"}}`
  → response shows `stage:"approved"` with the `draft` still present.

Rollback: Manage deployments → edit → pick Version 6 → Deploy.
