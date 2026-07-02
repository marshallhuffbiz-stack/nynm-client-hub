# Deploy checklist — Apps Script Version 9

Code batch prepared 2026-07-02 in the `client-hub-auto` worktree
(branch `feat/2026-07-02-relay-round2`). Live backend is **Version 8** — nothing
below is live until you redeploy. Behavior is pinned by `test/contract.test.mjs`
against the mock plus a pure-JS mirror of the new normalizers (194 tests green);
Code.gs carries the identical hand-ported logic (marked with `[V9]` comments).

## What changed (V8 → V9)

1. **Identity-immutable patches** (fixes "done requests vanish from the client
   portal", `.auto-improve/holds.md` 2026-07-01). `mergePatch_` is a blind
   overlay, so an `updateRequest` patch carrying `id`, `clientId`, or
   `createdAt` (e.g. a caller echoing a whole fetched row back as the patch, or
   a blank `clientId`) re-keyed or de-tenanted the row — and `doGet` filters
   requests by `clientId`, so the request silently disappeared from its
   client's portal forever. `handleUpdateRequest_` now deletes
   `id`/`clientId`/`createdAt` (and the internal `__row`) from every incoming
   patch before merging: row identity can never be destroyed over the wire.
   Same guard added to `mock-server/server.mjs` so mock and prod stay
   contract-identical.

2. **Sheets time/date cells serialize as real strings** (fixes events showing
   no time in the portal). Google Sheets coerces a written `"16:00"` into a
   time cell; GAS reads it back as a Date on the Sheets epoch, and the API
   served junk like `"1899-12-30T16:00:00.000Z"` — the portal's time formatter
   expects `"HH:MM"` and silently rendered nothing. Now:
   - **READ**: `decodeCell_` normalizes Events `time`/`endTime` to `"HH:MM"`
     (24h, zero-padded, spreadsheet timezone via `Utilities.formatDate`) and
     Events `date` to `"YYYY-MM-DD"` — Date cells, `"16:00:00"` seconds forms,
     and unpadded `"9:30"` all normalize; existing junk rows are healed at read
     time with no sheet edits. Belt-and-braces: any OTHER scalar column Sheets
     coerced into a datetime (e.g. an ISO `createdAt`) serializes back as an
     ISO string, never a raw Date.
   - **WRITE**: `encodeCell_` prefixes Events `date`/`time`/`endTime` with a
     leading apostrophe (Sheets' text-forcing prefix — not stored as part of
     the value), so new writes land as plain text; rewriting a legacy row
     self-heals it. Additionally, the header self-migration in
     `getOrCreateSheet_` pins those columns to plain-text format
     (`setNumberFormat("@")`).
   - **Mock**: no change needed — the mock's JSON store cannot hold Date
     objects, so this normalization is Code.gs-only. The algorithm is pinned by
     a pure-JS mirror test in `test/contract.test.mjs` (labeled
     `[Code.gs mirror]`; keep the two copies in sync by hand).

Untouched: tenant spoof-block, meta deep-merge, requeue, 413 upload guard, PIN
gate, constant-time admin-token compare, all transitions, GET/POST contract.

## How to redeploy as Version 9

1. Open the Apps Script project bound to the Client Hub sheet
   (`13doR_3WcCSzsGBa6Emd5zHnMiY7leDyJrkJaT0Zoew0`) — it's the STANDALONE
   "Untitled" script, not sheet-bound code.
2. Replace the entire `Code.gs` contents with this worktree's
   `apps-script/Code.gs` (select-all → paste). `appsscript.json` unchanged.
3. Save, then **Deploy → Manage deployments → edit the EXISTING deployment →
   Version: New version** (becomes Version 9) → Deploy. Do NOT create a new
   deployment — that would change the /exec URL the portal, Desk, and worker
   use.
4. No sheet migration needed; time normalization heals existing junk rows at
   read time.

## One-line verification per fix (against the live /exec URL)

- **Identity-immutable patches**: `POST {admin, action:"updateRequest", id:<real id>, patch:{stage:"done", type:"website", clientId:""}}` → then `GET ?client=<that client's token>` still lists the request, with its original `clientId`/`createdAt` intact.
- **Time normalization**: `GET ?client=<token of a client with a timed event>` → the event's `time`/`endTime` come back as `"HH:MM"` strings (e.g. `"16:00"`, never `"1899-12-30T..."`), `date` as `"YYYY-MM-DD"`, and the portal's Upcoming events card shows "at 4:00 PM …" again.
