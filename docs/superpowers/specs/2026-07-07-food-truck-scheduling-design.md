# Food Truck Scheduling — Design Spec

**Date:** 2026-07-07
**App:** Relay (nynm-client-hub) — portal + Desk + Apps Script backend + VPS worker
**First client:** Eats on 601 (`clientId: eats-on-601`, site `eatson601.com`)
**Status:** Approved design, pre-implementation.

---

## 1. Goal

Let the Eats on 601 client self-serve **food-truck scheduling** from the Relay portal — dropping trucks onto dates (multiple per day, recurring patterns supported) — so that scheduling automatically:

1. **Updates the live website** with a dynamic "on the lot today" view and a browsable monthly schedule, and
2. **Drives social posts** — a daily "who's on the lot today" post (automatic) and a monthly schedule graphic (drafted for Marshall's approval).

This removes two manual chores: the client no longer schedules trucks in a side channel, and Marshall no longer hand-builds the daily/monthly posts or website updates.

**Explicit scope boundary:** food trucks are a *separate concern* from big lot Events (Jeep Jam, Summer Kickoff). Events keep their existing tab and flow untouched.

---

## 2. Decisions (locked)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Placement | **New "Food Trucks" tab** in both portal and Desk (not folded into Events) |
| 2 | Vendor source | **Pick from a directory + add new** — backed by the existing 36-vendor list |
| 3 | Automation split | **Daily post auto-publishes; monthly schedule graphic drafts for approval** |
| 4 | Website surfaces | **"On the lot today" homepage block + browsable `/schedule` month page** |
| 5 | Default lot hours | **9 AM – 5 PM** (`09:00`–`17:00`, display `9A–5P`) — prefill, per-booking override |
| 6 | Daily post time | **8:00 AM ET** on days with ≥1 truck |

---

## 3. Current state (what already exists)

Grounding facts from codebase exploration (2026-07-07):

**Relay backend** — `client-hub/apps-script/Code.gs` (Apps Script V9, standalone "Untitled", Sheet `13doR_3W…Zoew0`):
- `COLS_REQUESTS` (`Code.gs:32`): `id, clientId, type, title, description, attachments, eventId, stage, comment, scheduledFor, draft, changeNote, createdAt, updatedAt, meta`
- `COLS_EVENTS` (`Code.gs:37`): `eventId, clientId, title, date, description, promoted, requestId, createdAt, updatedAt, time, endTime` (date/time TEXT-forced to dodge Sheets coercion)
- `REQUEST_TYPES` (`Code.gs:66`): `["post", "website", "design", "event-promo"]`
- Actions (doPost switch, `Code.gs:627`): `submitRequest, addEvent, updateRequest, promoteEvent, deleteRequest, uploadAttachment, postMessage, upsertClient`
- doGet payload: `?client=<token>` → `{client, requests[], events[]}`; `?admin=<token>` → adds `clients[]`.

**Portal** — `client-hub/portal/` (PWA, `?c=<token>`): segmented control Post | Website | Design | Event | Other; a generic Event form (`title, date, time, endTime, description` → `api.addEvent`); "Upcoming events" list. No vendor/truck concept.

**Desk** — `client-hub/desk/` (PWA, `?k=<token>`): tabs Requests / Events / Clients / History; ready→approve flow stages a draft then publishes or deploys.

**Worker** — `client-hub/worker/` (Hetzner VPS `5.161.224.224`, user `relay`, systemd `relay-worker.timer` 90s):
- `events-auto.mjs` `buildSiteEvent(ex)` — already emits `{ id, kind: "vendor-day"|"event", date, isoDate (ET-aware), title, description, meta }` with `meta` like `"9A–2P · FOOD TRUCK"`. ET offset logic (`etOffset`, DST-aware) already present.
- `site-sync.mjs` `syncSiteEvent()` — idempotent upsert into `events.json`, guarded (on `main`, clean, pull-first), commits only that file, pushes.
- `site-apply.mjs` `applySiteChange({manifest, git, io, live})` — stages arbitrary files from a scratch dir, commits, pushes, then `verifyLive()` polls the live URL (cache-bust) for `presentOnLive`/`absentOnLive` strings before marking done.
- `config.json` `sites` map: `eats-on-601 → { dir: "/Users/MarshallHuff/Eats On 601 Website", liveUrl: "https://eatson601.com" }`.
- Alerts: ntfy topic `nynm-relay-90299f6d`.
- Publish lane: `publish.mjs` (Postiz, FB→IG staggered; Hub `client.name` must equal Postiz customer name).

**Eats On 601 website** — `/Users/MarshallHuff/Eats On 601 Website` (Astro 5, content collections, Cloudflare Pages):
- `src/content/events.json` — 25 entries. Schema: `id, kind ("event"|"vendor-day"), date (display), isoDate, title, description, meta, icon` + rich event-only fields (`longDescription, lineup[], gallery[], features[], recap[]…`). **23 are `vendor-day` entries** (one truck per day). Only events with `longDescription` get a `/events/[id]/` detail page.
- `src/content/vendors.json` — **36 vendor directory entries**: `id, name, tagline, category, price ("$"|"$$"|"$$$")` (+ optional `stall, imageUrl, imageGradient`). A directory, **not** a schedule.
- `src/lib/vendorGroups.ts` — maps categories → 5 groups (Food / Sweets / Sips / Makers & More / On the Lot); `groupVendors()`.
- `src/content/config.ts` — Zod content-collection schemas.
- Home page (`src/pages/index.astro`) renders `UpcomingEvents.astro` (calendar) + `VendorLineup.astro` (standing roster of all 36; its "today's lineup" CTA currently **links to Facebook** for real-time info). `EventCard.astro` already styles `kind: "vendor-day"` differently from `"event"`.
- **Gap:** no per-day schedule, no "what trucks are on the lot today" page — visitors are sent to Facebook.

**Key insight:** the site-sync layer already understands `vendor-day`; the missing pieces are (a) a way for the client to *create* truck bookings, (b) a dedicated schedule data structure + website views, and (c) the automation.

---

## 4. Data model

### 4.1 Vendors registry (new backend sheet — single source of truth for the directory)

`SHEET_VENDORS`, `COLS_VENDORS`:

```
id          slug, genId_("ven") or slugified name (stable)
clientId    "eats-on-601"
name        "Island Boys Food Truck"
category    "CARIBBEAN"            (must map via vendorGroups categories)
price       "$" | "$$" | "$$$"
tagline     "Bajan-Caribbean · jerk chicken and island plates"
active      TRUE | FALSE
createdAt   ISO
updatedAt   ISO
```

- **Seeded once** from the site's existing `vendors.json` (36 rows) via a one-time import script.
- The worker **projects** the active registry rows back into the site's `vendors.json` on deploy, so the website directory stays in sync with what the client edits.

### 4.2 Bookings (new backend sheet — the schedule itself)

`SHEET_BOOKINGS`, `COLS_BOOKINGS`:

```
id          genId_("bkg")
clientId    "eats-on-601"
vendorId    FK → SHEET_VENDORS.id
vendorName  denormalized snapshot (resilient to rename)
date        "YYYY-MM-DD"           (TEXT-forced, like events)
startTime   "HH:MM"                (TEXT-forced; default "09:00")
endTime     "HH:MM"                (TEXT-forced; default "17:00")
note        optional free text     ("first visit!", "tacos + churros")
seriesId    optional — groups a "repeat weekly" batch for bulk edit/remove
status      "scheduled" | "cancelled"
createdAt   ISO
updatedAt   ISO
```

- **One booking = one truck on one date.** Multiple bookings sharing a `date` = multiple trucks that day.
- Recurring ("taco truck every Tuesday") = a batch of individual bookings sharing a `seriesId`, expanded when created. No standing recurrence engine — YAGNI.

### 4.3 Website schedule content (`src/content/schedule.json` — new)

Worker-generated, one object per date that has ≥1 scheduled booking:

```json
{
  "date": "2026-07-11",
  "isoDate": "2026-07-11T09:00:00-04:00",
  "display": "Sat · Jul 11",
  "vendors": [
    { "id": "island-boys-food-truck", "name": "Island Boys Food Truck",
      "category": "CARIBBEAN", "price": "$$", "hours": "11A–7P" },
    { "id": "bella-sweet-boutique", "name": "Bella Sweet Boutique",
      "category": "DESSERTS", "price": "$$", "hours": "12–5P" }
  ]
}
```

- ET-aware `isoDate` via the existing `etOffset`/`etIso` helpers in `events-auto.mjs`.
- `hours` display string built from `startTime`/`endTime` via the existing `compactTime` helper style (`"9A–5P"`).

### 4.4 Migration

The 23 existing `vendor-day` entries in `events.json` are **migrated into `schedule.json`** (one-time script) and removed from `events.json`, so there is one model: `events.json` = big events only, `schedule.json` = food trucks. `Jeep Jam` and `Summer Kickoff` stay in `events.json`.

---

## 5. Backend changes (Apps Script `Code.gs`)

New sheets `SHEET_VENDORS`, `SHEET_BOOKINGS` with column constants + `ensureSheet_` bootstrapping (mirror the existing Events pattern, incl. TEXT-forcing `date`/`startTime`/`endTime`).

New doPost actions (added to the `Code.gs:627` switch):

| Action | Payload | Effect |
|--------|---------|--------|
| `upsertVendor` | `{ vendor: {id?, name, category, price, tagline, active} }` | Add/update a registry row; returns `{vendorId}`. New truck from the portal "+ Add new". |
| `addBookings` | `{ bookings: [ {vendorId, date, startTime, endTime, note}… ], seriesId? }` | Batch insert (one round-trip for repeat-weekly); validates each; returns created ids. |
| `updateBooking` | `{ id, patch }` | Edit time/note or set `status:"cancelled"`. |
| `deleteBooking` | `{ id }` or `{ seriesId }` | Remove a booking or a whole series. |

Validation helper `validateBookingInput_` (mirror `validateEventInput_`, `Code.gs:358`): `clientId` required, `vendorId` resolvable, `date` ISO (`isoDate_`), `startTime`/`endTime` match `^([01]\d|2[0-3]):[0-5]\d$`, `endTime` ≥ `startTime`.

doGet payload additions:
- `?client=<token>` → add `vendors: [active registry rows for client]` and `bookings: [scheduled bookings for client]`.
- `?admin=<token>` → add `vendors[]` and `bookings[]` across clients (worker reads these).

The 30-second `LockService` guard (`Code.gs:620`) and `mergePatch` behavior are reused unchanged. Bookings are **not** requests — they do not enter the request pipeline; they are their own store (like Events).

---

## 6. Portal — "Food Trucks" tab

New tab in `portal/` alongside the existing request/event forms. UI (phone PWA):

1. **Month calendar** (default: current month; prev/next nav). Days with bookings show a count badge. Tap a day → day detail.
2. **Day detail**: lists that day's truck chips (name · hours · category) with remove (`x`) and tap-to-edit (time/note).
3. **Add a truck**: search field autocompleting over `vendors` (the registry). Selecting one adds a booking with default hours `9A–5P` (editable). A **"+ Add a new truck"** row opens a mini form (name, category from the known set, price, tagline) → `upsertVendor` then immediately books it.
4. **Repeat helper**: after adding, offer *"Repeat weekly through end of month"* → client expands to individual bookings (shared `seriesId`) via one `addBookings` call.

API additions in `shared/api.js` `portalApi`: `list/loaded via existing load()`, `upsertVendor(vendor)`, `addBookings(bookings, seriesId)`, `updateBooking(id, patch)`, `deleteBooking({id|seriesId})`. Optimistic local paint + reconcile on next poll (same pattern as `addEvent`).

Brand logo mapping already includes `eats-on-601` (`portal/app.js`). Tab visibility: gate the Food Trucks tab to clients with a `features.foodTrucks` flag (default on for `eats-on-601`, off for others) so it doesn't appear for The O etc.

---

## 7. Desk — "Food Trucks" tab

New tab in `desk/`. Read-mostly month view mirroring the portal, plus:
- Per-day **post status** chips: `scheduled → drafted → published` (or `failed`) for the daily post.
- The **monthly schedule graphic** arrives as a normal request in `ready` stage (type `post`, staged draft = the rendered graphic + caption) and is approved through the existing `readyActions()` → `api.update(id,{action:"approve"})` flow.
- An on-demand **"Post this month's schedule"** button that enqueues that draft immediately.
- Marshall can also add/cancel bookings here (same actions as the portal) for when he's doing it on the client's behalf.

---

## 8. Worker changes

### 8.1 Schedule reconcile job (`worker/schedule-sync.mjs` — new)

Runs on the existing worker poll tick (the `relay-worker.timer`, ~90s — reuse it rather than add a timer). For each site-enabled client:
1. Fetch `bookings` + `vendors` from the backend admin GET.
2. Build `schedule.json` (§4.3) — group scheduled bookings by date, resolve vendor fields, sort, ET-aware `isoDate`, `hours` display.
3. Build the projected `vendors.json` from active registry rows.
4. Diff against the repo's current files; if unchanged → no-op (idempotent, like `syncSiteEvent`).
5. If changed → stage both files into a scratch dir + `manifest.json` (`files, commitMessage, verify:{presentOnLive:[a truck name from today]}`), and deploy through **`site-apply.mjs`** (reusing push + `verifyLive`). Guards: on `main`, clean, pull-first — reuse `site-sync` guard style.

Config (`worker/config.json`, extend the `eats-on-601` entry):
```json
"schedule": {
  "enabled": true,
  "scheduleFile": "src/content/schedule.json",
  "vendorsFile": "src/content/vendors.json",
  "defaultHours": { "start": "09:00", "end": "17:00" },
  "dailyPostTime": "08:00",
  "monthlyDraftDay": 25,
  "postizChannels": ["<Eats FB channel>", "<Eats IG channel>"]
}
```
*(Postiz channel names are a config-time input — Hub `client.name` must equal the Postiz customer name. Placeholder until confirmed.)*

### 8.2 Daily auto-post (`worker/daily-truck-post.mjs` — new, VPS cron 8:00 AM ET)

1. Read today's (ET) scheduled bookings for Eats from the backend (source of truth, fresh).
2. If **0 trucks** → exit quietly (optionally a "no trucks today" internal log, no post).
3. If **≥1** → render a **branded lineup graphic** via the `branded-social-post` skill (Eats brand, the day's vendor names + hours) and a caption; publish to Eats FB + IG (staggered) via the Postiz lane.
4. **Alerting (required):** any failure in render or publish →
   - ntfy alert to `nynm-relay-90299f6d`, **and**
   - create a `post` request in the Desk pre-filled with the caption + a note ("daily truck post failed to auto-publish — review"), so it's never silently dropped.
5. Idempotency: record the posted date so a re-run same day does not double-post.

### 8.3 Monthly schedule draft (`worker/monthly-truck-post.mjs` — new, VPS cron on `monthlyDraftDay`, + on-demand)

1. Gather next month's (or current month's, on-demand) bookings.
2. Render a **branded monthly-calendar graphic** + caption.
3. Create a `post` request in **`ready`** stage with the staged draft → lands in Desk for approval → existing approve→publish lane ships it.

Both new cron jobs registered under the `relay` user (systemd timers), alert on failure per the automation rule.

---

## 9. Website changes (Eats On 601 Astro site)

1. **Content collection**: add `schedule` to `src/content/config.ts` (Zod schema matching §4.3). Add `src/content/schedule.json` (seeded by the migration).
2. **`OnTheLotToday.astro`** (new): embeds the schedule as JSON; **computes "today" client-side in `America/New_York`** (`Intl.DateTimeFormat` timeZone), finds today's entry, renders vendor cards (name, category chip, hours). Empty state: "No trucks booked today — see the full schedule →". Client-side "today" means the block is correct between deploys.
3. **Homepage integration** (`src/pages/index.astro` / `VendorLineup.astro`): place `OnTheLotToday` prominently and **replace the "check Facebook" CTA** with a link to `/schedule`. Keep `VendorLineup` as the standing roster ("who pulls up here").
4. **`/schedule` page** (`src/pages/schedule.astro`, new): month grid reading `schedule.json`, prev/next month nav, each day cell lists its trucks; tap-through optional. Reuse `VendorCard`/category styling and `vendorGroups` where useful.
5. **Migration script**: move `vendor-day` entries out of `events.json` into `schedule.json`; leave big events.

Deploys via the worker's `site-apply` verify-live lane (§8.1) — no manual pushes.

---

## 10. Phasing

**Phase 1 — Scheduling + website (ship first; immediately useful, low risk):**
- Backend: Vendors registry + Bookings sheets, actions, doGet payload, seed import.
- Portal Food Trucks tab (month calendar, picker, add-new, repeat helper).
- Desk Food Trucks tab (view + add/cancel).
- Worker `schedule-sync.mjs` → `schedule.json` + `vendors.json` projection + deploy.
- Website: `schedule` collection, `OnTheLotToday`, `/schedule`, homepage swap, migration.

**Phase 2 — Automation:**
- `daily-truck-post.mjs` (8 AM ET, auto-publish, ntfy + Desk-draft fallback).
- `monthly-truck-post.mjs` (month-end draft + on-demand button + approve flow).
- Desk per-day post-status surfacing.

---

## 11. Testing strategy (TDD; run-output evidence before "done")

- **Backend:** extend `test/gas-harness.mjs` — vendor upsert, booking validation, `addBookings` batch, delete by `id`/`seriesId`, doGet payload shape (vendors + bookings present, scoped by client). Redeploy Apps Script **test-first** (→ V10) and verify live with `?cb=`.
- **Worker:** unit tests mirroring `site-apply.test.mjs` — `schedule.json` builder (bookings → grouped days), `vendors.json` projection, reconcile diff/idempotency, daily-post "today in ET" selection, no-trucks-today path, failure→fallback-draft path, idempotent double-post guard.
- **Website:** `astro build` succeeds; `schedule.json` renders; `OnTheLotToday` ET-today logic unit-tested (mock dates across a DST boundary); `/schedule` renders a month.
- **End-to-end on dev tokens** (`?c=dev-eats`, `?k=dev-admin`) before prod tokens.

---

## 12. Risks / open items

- **Postiz channel names** for Eats FB + IG — config-time input; Hub `client.name` must equal the Postiz customer name (publish lane depends on it).
- **Daily auto-publish is a new no-human-gate path** for Relay — mitigated by the ntfy alert + Desk-draft fallback (§8.2) and the double-post idempotency guard.
- **Client-side "today"** depends on a recent deploy reflecting the latest bookings; the reconcile job keeps `schedule.json` current within a poll cycle.
- **vendorGroups categories**: "+ Add new truck" must constrain `category` to the known set so grouping/website rendering stays valid.
- **Migration** must not drop rich event data — only `kind:"vendor-day"` entries move; big events stay.

---

## 13. Assumptions (locked with Marshall 2026-07-07)

- Default hours **9 AM–5 PM**, per-booking override.
- Daily post fires **8:00 AM ET**, days with ≥1 truck.
- Daily = branded lineup **graphic** (not text-only).
- Existing 23 `vendor-day` entries **migrate** into `schedule.json`.
- Food Trucks tab **gated** to Eats (feature flag), invisible for other clients.
