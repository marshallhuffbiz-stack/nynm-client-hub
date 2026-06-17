# Client Hub — design spec

**Date:** 2026-06-16
**Author:** Claude (brainstormed with Marshall Huff)
**Status:** Approved — autonomous build via `/auto`

---

## 1. Problem

Marshall's clients text him requests (a post they want, an event, a website tweak), usually with photos. Today he screenshots those texts and feeds them by hand into his Claude systems to produce and schedule the work. That manual screenshot-and-paste step is the bottleneck.

**Goal:** one unified place where clients submit structured requests (with photos), everything lands in a single queue Marshall sees, and **one tap** kicks Claude off to do the work — Claude picks the right skill, builds a draft, and stages it. Marshall reviews and approves; only then does it ship.

This replaces "screenshot a text → paste into a system" with "client fills a form → Marshall taps Send → Claude builds → Marshall approves → it ships."

## 2. Approved decisions (from the brainstorm)

| Decision | Choice |
|---|---|
| Approval model | **Stage it, Marshall approves.** Claude does the full work and stages a draft. Nothing goes live until Marshall taps Approve. |
| Request types | **All four:** social post / flyer, website fix, design / graphic, special event (calendar). |
| Client login | **Private link per client** (one secret URL, optional 4-digit PIN). No passwords. |
| Events | **Show on hub + 1-tap promote.** Events are informational; a button turns one into a post request on demand. |
| System boundary | **Separate system.** Own Google Sheet, own Apps Script deploy, own worker. Cannot affect the lead pipeline. |
| Notifications | **Phone push + Mac notification + daily digest** on new requests. |
| Attachments | **Upload in the portal** (stored to Drive in prod; local folder in mock). |
| Pilot scale | **1–3 clients** to start (The O, Eats on 601, A New Day). |

## 3. Architecture

Mirrors the proven `lead-responder` system: a Google Sheet as the datastore, an Apps Script web app as a token-gated JSON API, static PWAs as clients, and a launchd worker on Marshall's Mac that fires `claude` headless to do the work.

```
Client Portal (PWA)  ─┐
                      ├─► Apps Script API ─► Google Sheet  ◄─► Worker (launchd) ─► claude -p drain.md
Request Desk (PWA)   ─┘     (token-gated)     (3 tabs)         (every ~5 min)        (picks a skill,
   Marshall                                                                            stages a draft)
```

**Autonomous-build strategy:** the build cannot use Marshall's Google account unattended, so everything is built against a **local mock backend** (`mock-server/` — a Node HTTP server that mimics the Apps Script API over a JSON store). The PWAs are fully functional locally. Going to production is a one-line base-URL swap plus the deferred setup steps (§10).

## 4. Data model — Google Sheet "NYNM Client Hub", 3 tabs

### Clients
One row per client. Marshall-owned (set up once per client).

| Field | Notes |
|---|---|
| `clientId` | slug, e.g. `the-o` (primary key) |
| `name` | display name, "The O" |
| `token` | secret link token (24+ chars) |
| `pin` | optional 4-digit string, "" if none |
| `brandSlug` | folder under `~/.claude/brands/<slug>` |
| `postizChannels` | JSON array of Postiz channel ids/names |
| `siteFolder` | absolute path if Marshall hosts their site, else "" |
| `active` | TRUE/FALSE |
| `createdAt`, `updatedAt` | ISO timestamps |

### Requests (the queue)
| Field | Notes |
|---|---|
| `id` | `req_<ts>_<rand>` (primary key) |
| `clientId` | FK → Clients |
| `type` | `post` \| `website` \| `design` \| `event-promo` |
| `title` | short summary |
| `description` | the request body (what the client wrote) |
| `attachments` | JSON array of `{name, url, mime}` |
| `eventId` | set if promoted from an event, else "" |
| `stage` | lifecycle (§5) |
| `comment` | Marshall's context for Claude |
| `scheduledFor` | ISO datetime, for posts |
| `draft` | JSON staged artifact `{caption, imageUrl, preview, summary, artifactPath, channel}` |
| `changeNote` | set when Marshall requests changes |
| `createdAt`, `updatedAt` | ISO |
| `meta` | JSON, worker-owned: `{run:{status,startedAt,finishedAt,skill,error}, activity:[{at,kind,text}]}` |

### Events
| Field | Notes |
|---|---|
| `eventId` | `evt_<ts>_<rand>` |
| `clientId` | FK |
| `title`, `date` (ISO date), `description` | event detail |
| `promoted` | TRUE/FALSE |
| `requestId` | the request created when promoted, else "" |
| `createdAt`, `updatedAt` | ISO |

## 5. Request lifecycle (stage machine)

```
submitted ──(Marshall: Send to Claude)──► queued ──(worker picks up)──► drafting ──► ready
   ▲                                                                                    │
   │ (client only ever creates `submitted`)                  ┌──(Marshall: Approve)─────┤
                                                             ▼                          │
                                                         approved ──(worker ships)──► shipping ──► done
                                              (Marshall: Request changes + note)        │
   changes ◄────────────────────────────────────────────────────────────────────────-─┘
      └──(worker re-drafts)──► drafting ──► ready
   error ◄── (worker failure; meta.run.error set; retried up to a cap)
```

Ownership of transitions:
- **Portal (client):** creates `submitted` only.
- **Request Desk (Marshall):** `queued` (Send to Claude), `approved` (Approve), `changes` (Request changes + note), and edits `comment`.
- **Worker:** `drafting`, `ready`, `shipping`, `done`, `error`; writes `draft` + `meta`.

## 6. API contract (mock server and Apps Script are identical)

One endpoint, token-gated, JSON.

**GET**
- `?c=<clientToken>[&pin=<pin>]` → `{ok, client:{public fields}, requests:[client's], events:[client's]}`
- `?admin=<adminToken>` → `{ok, clients:[...], requests:[all], events:[all]}`

**POST** (JSON body)
| action | token | body | returns |
|---|---|---|---|
| `submitRequest` | c | `request:{clientId,type,title,description,attachments,eventId?}` | `{ok,id}` (stage=submitted) |
| `addEvent` | c | `event:{clientId,title,date,description}` | `{ok,eventId}` |
| `uploadAttachment` | c | `file:{name,mime,dataBase64}` | `{ok,url}` |
| `updateRequest` | admin | `id, patch:{stage?,comment?,scheduledFor?,draft?,changeNote?,meta?}` | `{ok}` |
| `promoteEvent` | admin | `eventId` | `{ok,requestId}` |
| `upsertClient` | admin | `client:{...}` | `{ok,clientId}` |

**Concurrency:** every write re-reads the freshest row and merges field-wise (last-write-wins by `updatedAt`), guarded by `LockService` (Apps Script) or a file lock (mock). Ported from `lead-responder`.

## 7. Components

- `core/model.mjs` — **pure logic, TDD'd**: schema validation, stage-transition rules, client/token validation, optimistic-merge, skill routing (type→skill), notification-trigger detection. No I/O. Shared by mock-server, worker, and (conceptually mirrored in) Apps Script.
- `mock-server/` — Node HTTP server implementing §6 over a JSON store (`data/store.json`). Localhost only.
- `apps-script/Code.gs` — the real backend, same contract, Sheet-backed, LockService. Plus `appsscript.json`.
- `portal/` — Client Portal PWA: per-type request form, photo upload, events calendar, request history. Reads `?c=` token.
- `desk/` — Request Desk PWA: all requests, comment box, Send-to-Claude, draft preview, Approve / Request-changes, events with 1-tap promote. Reads `?k=` admin token.
- `shared/config.js` — `API_BASE` (mock vs real) — the one-line production swap.
- `shared/api.js` — browser API client.
- `worker/` — `poller.mjs` (launchd entry), `drain.md` (headless Claude protocol), `claude-settings.json`, `writeback.mjs`, `notify.mjs`, `config.example.json`, `com.nynm.client-worker.plist`.
- `scripts/` — `seed.mjs` (load pilot clients), `dev.mjs` (run mock + static serve for local verify).

## 8. Skill routing (worker drain)

| Request type | Skill | On approve |
|---|---|---|
| `post` | `branded-social-post` | schedule via `post` (Postiz) |
| `design` | `branded-social-post` / `imagery` / `branded-collateral` (by description) | deliver file; post if asked |
| `website` | edit `siteFolder` repo → staged diff/preview (if hosted), else written change + mockup | apply change (still Marshall-gated) |
| `event-promo` | `branded-social-post` for the event | schedule via `post` |

Everything stages a draft; nothing ships without `approved`.

## 9. Notifications

`worker/notify.mjs`, pluggable transports:
- **Mac notification** — `osascript -e 'display notification ...'` (known, implemented).
- **Phone push** — wired to Marshall's existing push path (same one the Postiz guardian / lead worker uses); stubbed + logged if unavailable, so it never blocks.
- **Daily digest** — once/day the poller composes one summary of open requests and sends it via the same transports.

Triggers: new `submitted` request → immediate push + Mac. Digest → daily at a configured hour.

## 10. Security

- Tokens random ≥24 chars. Portal: `…/portal/?c=<token>`. Desk: `…/desk/?k=<adminToken>`. Optional PIN as a second factor for the portal.
- Mock server binds `127.0.0.1` only.
- Production: Apps Script token-gated exactly like `lead-responder`; secrets in `worker/config.json` (gitignored), never in the repo.

## 11. Testing strategy

- **TDD** the pure logic in `core/model.mjs` (validation, transitions, merge, routing, notif triggers) — `node --test`.
- **Contract tests** against the mock server (start it, curl each endpoint, assert shape).
- **Browser verification** of both PWAs via the preview tools: submit → Send → (simulate worker staging a draft) → Approve, with screenshots.
- Worker's live `claude` drain is **not** fully runnable unattended (it would spawn Claude recursively); its pure logic (job detection, writeback merge, notify formatting) is unit-tested, and the live drain is documented as requiring a real run — marked honestly as unverified.

## 12. Deferred to production (needs Marshall's accounts — review queue)

1. Create the Google Sheet "NYNM Client Hub" with the 3 tabs.
2. Deploy `apps-script/Code.gs` as a web app; copy the exec URL + token.
3. Set `shared/config.js` `API_BASE` to the live URL (the one-line swap).
4. Fill `worker/config.json` with real Postiz channel ids + Drive folder + admin token.
5. Host the PWAs publicly (GitHub Pages or `publish-product`); generate each client's secret link.
6. Install + activate `com.nynm.client-worker.plist` against the live URL.

These are queued in `.auto/deferred-actions.md` with exact steps.
