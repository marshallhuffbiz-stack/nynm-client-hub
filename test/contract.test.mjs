import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../mock-server/server.mjs";

let srv, base, dir, storePath;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "client-hub-"));
  storePath = join(dir, "store.json");
  await writeFile(
    storePath,
    JSON.stringify({
      settings: { adminToken: "testadmin" },
      clients: [{ clientId: "the-o", name: "The O", token: "tok-o", pin: "", active: true }],
      requests: [],
      events: [],
    })
  );
  srv = createApp({ storePath });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${srv.address().port}`;
});

after(async () => {
  await new Promise((r) => srv.close(r));
  await rm(dir, { recursive: true, force: true });
});

const get = (q) => fetch(`${base}/${q}`).then(async (r) => ({ status: r.status, body: await r.json() }));
const post = (b) =>
  fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(
    async (r) => ({ status: r.status, body: await r.json() })
  );

test("admin GET returns everything; bad token rejected", async () => {
  const ok = await get("?admin=testadmin");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.clients.length, 1);
  const bad = await get("?admin=nope");
  assert.equal(bad.status, 403);
});

test("client GET scoped to the client; bad link rejected", async () => {
  const ok = await get("?c=tok-o");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.client.name, "The O");
  assert.equal(ok.body.client.token, undefined); // secrets stripped
  const bad = await get("?c=wrong");
  assert.equal(bad.status, 403);
});

test("submitRequest creates a submitted request, visible to client + admin", async () => {
  const r = await post({ c: "tok-o", action: "submitRequest", request: { type: "post", description: "Promote our Friday sidewalk sale" } });
  assert.equal(r.status, 200);
  assert.ok(r.body.id);
  const cv = await get("?c=tok-o");
  assert.equal(cv.body.requests.length, 1);
  assert.equal(cv.body.requests[0].stage, "submitted");
  const av = await get("?admin=testadmin");
  assert.equal(av.body.requests.length, 1);
});

test("client cannot hit admin actions", async () => {
  const r = await post({ c: "tok-o", action: "updateRequest", id: "x", patch: {} });
  assert.equal(r.status, 403);
});

test("the full stage machine: send -> start -> ready -> approve -> ship -> done", async () => {
  const created = await post({ c: "tok-o", action: "submitRequest", request: { type: "design", description: "new menu graphic" } });
  const id = created.body.id;
  const send = await post({ admin: "testadmin", action: "updateRequest", id, patch: { action: "send", comment: "make it pop" } });
  assert.equal(send.body.request.stage, "queued");
  assert.equal(send.body.request.comment, "make it pop");
  const start = await post({ admin: "testadmin", action: "updateRequest", id, patch: { action: "start" } });
  assert.equal(start.body.request.stage, "drafting");
  const ready = await post({ admin: "testadmin", action: "updateRequest", id, patch: { action: "ready", draft: { caption: "hi" } } });
  assert.equal(ready.body.request.stage, "ready");
  const approve = await post({ admin: "testadmin", action: "updateRequest", id, patch: { action: "approve" } });
  assert.equal(approve.body.request.stage, "approved");
  const ship = await post({ admin: "testadmin", action: "updateRequest", id, patch: { action: "ship" } });
  assert.equal(ship.body.request.stage, "shipping");
  const done = await post({ admin: "testadmin", action: "updateRequest", id, patch: { action: "done" } });
  assert.equal(done.body.request.stage, "done");
});

test("illegal transition is rejected (409)", async () => {
  const created = await post({ c: "tok-o", action: "submitRequest", request: { type: "post", description: "x" } });
  const bad = await post({ admin: "testadmin", action: "updateRequest", id: created.body.id, patch: { action: "approve" } });
  assert.equal(bad.status, 409);
});

test("addEvent then promoteEvent creates an event-promo request", async () => {
  const ev = await post({ c: "tok-o", action: "addEvent", event: { title: "Live music", date: "2026-07-04", description: "patio set" } });
  assert.equal(ev.status, 200);
  const promo = await post({ admin: "testadmin", action: "promoteEvent", eventId: ev.body.eventId });
  assert.equal(promo.status, 200);
  assert.ok(promo.body.requestId);
  const av = await get("?admin=testadmin");
  const evRow = av.body.events.find((e) => e.eventId === ev.body.eventId);
  assert.equal(evRow.promoted, true);
  const promoReq = av.body.requests.find((r) => r.id === promo.body.requestId);
  assert.equal(promoReq.type, "event-promo");
});

test("uploadAttachment stores a file and returns a fetchable url", async () => {
  const b64 = Buffer.from("hello-pixels").toString("base64");
  const up = await post({ c: "tok-o", action: "uploadAttachment", file: { name: "shot.txt", mime: "text/plain", dataBase64: b64 } });
  assert.equal(up.status, 200);
  assert.match(up.body.url, /\/uploads\//);
  const got = await fetch(up.body.url);
  assert.equal(got.status, 200);
  assert.equal(await got.text(), "hello-pixels");
});

test("deleteRequest removes a request (admin only); 404 for a missing id", async () => {
  const created = await post({ c: "tok-o", action: "submitRequest", request: { type: "post", description: "a test submission to delete" } });
  const id = created.body.id;
  // a client cannot delete
  const forbidden = await post({ c: "tok-o", action: "deleteRequest", id });
  assert.equal(forbidden.status, 403);
  // admin deletes it
  const del = await post({ admin: "testadmin", action: "deleteRequest", id });
  assert.equal(del.status, 200);
  assert.equal(del.body.deleted, true);
  // it is gone from the admin view
  const av = await get("?admin=testadmin");
  assert.equal(av.body.requests.find((r) => r.id === id), undefined);
  // deleting a missing id 404s
  const missing = await post({ admin: "testadmin", action: "deleteRequest", id: "req_nope" });
  assert.equal(missing.status, 404);
});

test("addEvent stores an optional start time; bad time rejected", async () => {
  const ev = await post({ c: "tok-o", action: "addEvent", event: { title: "Trivia night", date: "2026-07-10", time: "19:30" } });
  assert.equal(ev.status, 200);
  const cv = await get("?c=tok-o");
  const row = cv.body.events.find((e) => e.eventId === ev.body.eventId);
  assert.equal(row.time, "19:30");
  const bad = await post({ c: "tok-o", action: "addEvent", event: { title: "x", date: "2026-07-10", time: "25:99" } });
  assert.equal(bad.status, 400);
});

/* ---------- V7 contract: endTime round-trip ---------- */

test("addEvent stores an optional end time and round-trips it; bad endTime rejected", async () => {
  const ev = await post({ c: "tok-o", action: "addEvent", event: { title: "Wine tasting", date: "2026-07-18", time: "19:00", endTime: "22:00" } });
  assert.equal(ev.status, 200);
  const cv = await get("?c=tok-o");
  const row = cv.body.events.find((e) => e.eventId === ev.body.eventId);
  assert.equal(row.time, "19:00");
  assert.equal(row.endTime, "22:00");
  const av = await get("?admin=testadmin");
  const arow = av.body.events.find((e) => e.eventId === ev.body.eventId);
  assert.equal(arow.endTime, "22:00");
  const bad = await post({ c: "tok-o", action: "addEvent", event: { title: "x", date: "2026-07-18", endTime: "26:00" } });
  assert.equal(bad.status, 400);
});

test("promoteEvent carries start and end times into the promo description", async () => {
  const ev = await post({
    c: "tok-o", action: "addEvent",
    event: { title: "Karaoke", date: "2026-07-11", time: "19:00", endTime: "22:00", description: "prizes for best duet" },
  });
  const promo = await post({ admin: "testadmin", action: "promoteEvent", eventId: ev.body.eventId });
  assert.equal(promo.status, 200);
  const av = await get("?admin=testadmin");
  const req = av.body.requests.find((r) => r.id === promo.body.requestId);
  assert.match(req.description, /Karaoke on 2026-07-11/);
  assert.match(req.description, /7:00 PM–10:00 PM/);
  assert.match(req.description, /prizes for best duet/);
});

test("promoteEvent with only a start time says 'starting ...'", async () => {
  const ev = await post({ c: "tok-o", action: "addEvent", event: { title: "Open mic", date: "2026-07-12", time: "18:30" } });
  const promo = await post({ admin: "testadmin", action: "promoteEvent", eventId: ev.body.eventId });
  const av = await get("?admin=testadmin");
  const req = av.body.requests.find((r) => r.id === promo.body.requestId);
  assert.match(req.description, /starting 6:30 PM/);
});

/* ---------- V7 contract: server-side meta deep-merge ---------- */

test("a meta patch merges instead of clobbering (thread + activity + idempotency key survive)", async () => {
  const created = await post({
    c: "tok-o", action: "submitRequest", clientRequestId: "cli_merge_1",
    request: { type: "post", description: "meta merge test" },
  });
  const id = created.body.id;
  // a client message lands after the worker's fetch...
  await post({ c: "tok-o", action: "postMessage", id, text: "Actually make it blue" });
  // ...then a worker writeback patches only meta.run
  const wb = await post({ admin: "testadmin", action: "updateRequest", id, patch: { meta: { run: { phase: "draft", error: "render failed" } } } });
  assert.equal(wb.status, 200);
  const m = wb.body.request.meta;
  assert.equal(m.run.error, "render failed");
  assert.equal(m.thread.length, 1); // client message survived
  assert.equal(m.thread[0].text, "Actually make it blue");
  assert.equal(m.clientRequestId, "cli_merge_1"); // idempotency key survived
  assert.ok(m.activity.some((a) => a.kind === "created")); // audit trail survived
});

test("an action patch carrying stale meta keeps the server's activity entry, no duplicates", async () => {
  const created = await post({ c: "tok-o", action: "submitRequest", request: { type: "post", description: "activity keep test" } });
  const id = created.body.id;
  // worker sends action + a stale full-meta copy (as old writebacks did)
  const av = await get("?admin=testadmin");
  const stale = av.body.requests.find((r) => r.id === id).meta;
  const send = await post({ admin: "testadmin", action: "updateRequest", id, patch: { action: "send", meta: { ...stale, notified: true } } });
  assert.equal(send.status, 200);
  const m = send.body.request.meta;
  assert.equal(m.notified, true); // the delta landed
  const kinds = m.activity.map((a) => a.kind);
  assert.ok(kinds.includes("created"));
  assert.ok(kinds.includes("send")); // the entry the server just appended was NOT dropped
  assert.equal(m.activity.filter((a) => a.kind === "created").length, 1); // union, not duplicate
});

/* ---------- V7 contract: first-class requeue action ---------- */

test("requeue after a publish failure returns to approved KEEPING the draft", async () => {
  const created = await post({ c: "tok-o", action: "submitRequest", request: { type: "post", description: "publish retry test" } });
  const id = created.body.id;
  await post({ admin: "testadmin", action: "updateRequest", id, patch: { action: "send" } });
  await post({ admin: "testadmin", action: "updateRequest", id, patch: { action: "start" } });
  await post({ admin: "testadmin", action: "updateRequest", id, patch: { action: "ready", draft: { caption: "approved creative" } } });
  await post({ admin: "testadmin", action: "updateRequest", id, patch: { action: "approve" } });
  await post({ admin: "testadmin", action: "updateRequest", id, patch: { action: "ship" } });
  const err = await post({ admin: "testadmin", action: "updateRequest", id, patch: { action: "error", meta: { run: { phase: "publish", error: "Postiz 502" } } } });
  assert.equal(err.body.request.stage, "error");
  const rq = await post({ admin: "testadmin", action: "updateRequest", id, patch: { action: "requeue" } });
  assert.equal(rq.status, 200);
  assert.equal(rq.body.request.stage, "approved");
  assert.deepEqual(rq.body.request.draft, { caption: "approved creative" }); // draft KEPT
  assert.equal(rq.body.request.meta.run.error, ""); // stale error cleared
  assert.ok(rq.body.request.meta.activity.some((a) => a.kind === "requeue")); // audit-logged
});

test("requeue of a draft-phase failure re-queues for a fresh draft; rescues stuck shipping; 409 elsewhere", async () => {
  // draft-phase failure -> queued, draft cleared
  const a = await post({ c: "tok-o", action: "submitRequest", request: { type: "post", description: "draft retry test" } });
  await post({ admin: "testadmin", action: "updateRequest", id: a.body.id, patch: { action: "send" } });
  await post({ admin: "testadmin", action: "updateRequest", id: a.body.id, patch: { action: "start" } });
  await post({ admin: "testadmin", action: "updateRequest", id: a.body.id, patch: { action: "error", meta: { run: { phase: "draft", error: "render crashed" } } } });
  const rqA = await post({ admin: "testadmin", action: "updateRequest", id: a.body.id, patch: { action: "requeue" } });
  assert.equal(rqA.body.request.stage, "queued");
  assert.equal(rqA.body.request.draft, null);

  // stuck shipping row (publish phase, draft present) -> approved, draft kept
  const b = await post({ c: "tok-o", action: "submitRequest", request: { type: "post", description: "stuck shipping test" } });
  const bad = await post({ admin: "testadmin", action: "updateRequest", id: b.body.id, patch: { action: "requeue" } });
  assert.equal(bad.status, 409); // illegal from submitted
  await post({ admin: "testadmin", action: "updateRequest", id: b.body.id, patch: { action: "send" } });
  await post({ admin: "testadmin", action: "updateRequest", id: b.body.id, patch: { action: "start" } });
  await post({ admin: "testadmin", action: "updateRequest", id: b.body.id, patch: { action: "ready", draft: { caption: "c" } } });
  await post({ admin: "testadmin", action: "updateRequest", id: b.body.id, patch: { action: "approve" } });
  await post({ admin: "testadmin", action: "updateRequest", id: b.body.id, patch: { action: "ship" } });
  await post({ admin: "testadmin", action: "updateRequest", id: b.body.id, patch: { meta: { run: { phase: "publish" } } } });
  const rqB = await post({ admin: "testadmin", action: "updateRequest", id: b.body.id, patch: { action: "requeue" } });
  assert.equal(rqB.body.request.stage, "approved");
  assert.deepEqual(rqB.body.request.draft, { caption: "c" });
});

test("postMessage threads client + team replies; empty + missing rejected", async () => {
  const created = await post({ c: "tok-o", action: "submitRequest", request: { type: "post", description: "thread test" } });
  const id = created.body.id;
  const m1 = await post({ c: "tok-o", action: "postMessage", id, text: "Can you make it brighter?" });
  assert.equal(m1.status, 200);
  assert.equal(m1.body.request.meta.thread.length, 1);
  assert.equal(m1.body.request.meta.thread[0].from, "client");
  const m2 = await post({ admin: "testadmin", action: "postMessage", id, text: "On it." });
  assert.equal(m2.body.request.meta.thread.at(-1).from, "team");
  const empty = await post({ admin: "testadmin", action: "postMessage", id, text: "   " });
  assert.equal(empty.status, 400);
  const missing = await post({ admin: "testadmin", action: "postMessage", id: "req_nope", text: "hi" });
  assert.equal(missing.status, 404);
});

// [V9] Regression pin for the "done requests vanish from the portal" hold
// (.auto-improve/holds.md, 2026-07-01): mergePatch is a blind overlay, so a patch
// carrying id/clientId/createdAt (a caller echoing a fetched row, or a blank
// clientId) re-keyed or de-tenanted the row and the client GET (which filters on
// clientId) lost it. Identity fields must be immutable through updateRequest.
test("done+type patch keeps the request visible to its client; identity fields immutable", async () => {
  // Second tenant so we can prove the row neither vanishes nor jumps tenants.
  const up = await post({ admin: "testadmin", action: "upsertClient", client: { clientId: "eats", name: "Eats" } });
  assert.equal(up.status, 200);
  const eatsTok = up.body.token;

  const created = await post({ c: "tok-o", action: "submitRequest", request: { type: "post", description: "vanish regression" } });
  const id = created.body.id;

  // The exact patch from the observed hold: stage=done + type=website.
  const done = await post({ admin: "testadmin", action: "updateRequest", id, patch: { stage: "done", type: "website" } });
  assert.equal(done.status, 200);
  assert.equal(done.body.request.stage, "done");
  assert.equal(done.body.request.type, "website");
  assert.equal(done.body.request.clientId, "the-o");
  const afterDone = await get("?c=tok-o");
  assert.ok(afterDone.body.requests.some((r) => r.id === id), "done request must stay visible to its client");

  // Hostile/echoed patches must not re-key or de-tenant the row.
  const createdAt = done.body.request.createdAt;
  const hijack = await post({
    admin: "testadmin",
    action: "updateRequest",
    id,
    patch: { id: "req_hijacked", clientId: "eats", createdAt: "1999-01-01T00:00:00.000Z", comment: "still here" },
  });
  assert.equal(hijack.status, 200);
  assert.equal(hijack.body.request.id, id, "id is immutable through patches");
  assert.equal(hijack.body.request.clientId, "the-o", "clientId is immutable through patches");
  assert.equal(hijack.body.request.createdAt, createdAt, "createdAt is immutable through patches");
  assert.equal(hijack.body.request.comment, "still here", "non-identity keys still patch");

  const blank = await post({ admin: "testadmin", action: "updateRequest", id, patch: { clientId: "" } });
  assert.equal(blank.body.request.clientId, "the-o");

  const oView = await get("?c=tok-o");
  assert.ok(oView.body.requests.some((r) => r.id === id), "request still visible to its own client");
  const eatsView = await get(`?c=${eatsTok}`);
  assert.ok(!eatsView.body.requests.some((r) => r.id === id), "request never leaks into another tenant");
});

// ---------------------------------------------------------------------------
// [V9] Pure-JS mirror of apps-script/Code.gs normalizeTimeCell_ / normalizeDateCell_.
// Google Sheets coerces a "16:00" string into a time cell; GAS reads it back as a
// Date on the Sheets epoch (1899-12-30T16:00), and the live API used to serialize
// that junk ("1899-12-30T16:00:00.000Z") while the portal expected "HH:MM".
// The mock's JSON store can never hold Date objects, so the normalization lives
// ONLY in Code.gs — this replica pins the algorithm (keep the two in sync by hand;
// Utilities.formatDate(date, tz, pattern) is shimmed with Intl below).
// ---------------------------------------------------------------------------
function formatDateShim(d, tz, pattern) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d).reduce((o, p) => ((o[p.type] = p.value), o), {});
  if (pattern === "HH:mm") return `${parts.hour}:${parts.minute}`;
  if (pattern === "yyyy-MM-dd") return `${parts.year}-${parts.month}-${parts.day}`;
  throw new Error("unsupported pattern " + pattern);
}

// Mirrors Code.gs normalizeTimeCell_ (tz passed explicitly; GAS uses sheetTz_()).
function normalizeTimeCellMirror(raw, tz) {
  if (raw === null || raw === undefined || raw === "") return "";
  if (Object.prototype.toString.call(raw) === "[object Date]") {
    return formatDateShim(raw, tz, "HH:mm");
  }
  let s = String(raw).trim();
  if (s.charAt(0) === "'") s = s.slice(1); // stray text-forcing apostrophe
  const m = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(s);
  if (m) return ("0" + m[1]).slice(-2) + ":" + m[2];
  return s;
}

// Mirrors Code.gs normalizeDateCell_.
function normalizeDateCellMirror(raw, tz) {
  if (raw === null || raw === undefined || raw === "") return "";
  if (Object.prototype.toString.call(raw) === "[object Date]") {
    return formatDateShim(raw, tz, "yyyy-MM-dd");
  }
  let s = String(raw).trim();
  if (s.charAt(0) === "'") s = s.slice(1);
  return s;
}

test("[Code.gs mirror] Sheets time/date cells normalize to HH:MM / YYYY-MM-DD strings", () => {
  // The signature junk value: a "16:00" cell read back as a Sheets-epoch Date.
  assert.equal(normalizeTimeCellMirror(new Date("1899-12-30T16:00:00.000Z"), "UTC"), "16:00");
  // Any Date landing in a time column normalizes, epoch or not.
  assert.equal(normalizeTimeCellMirror(new Date("2026-07-04T09:05:00.000Z"), "UTC"), "09:05");
  // Wall-clock time respects the spreadsheet timezone, not UTC.
  assert.equal(normalizeTimeCellMirror(new Date("2026-07-04T23:30:00.000Z"), "America/New_York"), "19:30");
  // String forms: pass through / trim seconds / zero-pad.
  assert.equal(normalizeTimeCellMirror("16:00", "UTC"), "16:00");
  assert.equal(normalizeTimeCellMirror("16:00:00", "UTC"), "16:00");
  assert.equal(normalizeTimeCellMirror("9:30", "UTC"), "09:30");
  assert.equal(normalizeTimeCellMirror("", "UTC"), "");
  assert.equal(normalizeTimeCellMirror(null, "UTC"), "");
  // Unparseable content passes through untouched (never throws).
  assert.equal(normalizeTimeCellMirror("TBD", "UTC"), "TBD");
  // A stray literal text-forcing apostrophe (harness/CSV round-trips) is stripped.
  assert.equal(normalizeTimeCellMirror("'19:30", "UTC"), "19:30");

  assert.equal(normalizeDateCellMirror(new Date("2026-07-04T00:00:00.000Z"), "UTC"), "2026-07-04");
  assert.equal(normalizeDateCellMirror(new Date("2026-07-04T05:00:00.000Z"), "America/New_York"), "2026-07-04");
  assert.equal(normalizeDateCellMirror("2026-07-04", "UTC"), "2026-07-04");
  assert.equal(normalizeDateCellMirror("", "UTC"), "");
});

/* ============================ Food Trucks: vendors + bookings ============================ */

test("upsertVendor creates a vendor (slug id from name) and it appears in doGet payloads", async () => {
  const r = await post({
    c: "tok-o", action: "upsertVendor",
    vendor: { name: "Island Boys Food Truck", category: "CARIBBEAN", price: "$$", tagline: "Jerk chicken and island plates" },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.vendorId, "island-boys-food-truck"); // slug from name
  // client view carries active vendors
  const cv = await get("?c=tok-o");
  assert.ok(Array.isArray(cv.body.vendors));
  const v = cv.body.vendors.find((x) => x.id === "island-boys-food-truck");
  assert.equal(v.name, "Island Boys Food Truck");
  assert.equal(v.category, "CARIBBEAN");
  assert.equal(v.price, "$$");
  assert.equal(v.clientId, "the-o");
  assert.equal(v.active, true);
  assert.ok(v.createdAt && v.updatedAt);
  // admin view carries all vendors + bookings arrays
  const av = await get("?admin=testadmin");
  assert.ok(Array.isArray(av.body.vendors));
  assert.ok(Array.isArray(av.body.bookings));
  assert.ok(av.body.vendors.some((x) => x.id === "island-boys-food-truck"));
});

test("upsertVendor with an explicit id updates the existing row (no duplicate); bad price rejected", async () => {
  const created = await post({ c: "tok-o", action: "upsertVendor", vendor: { name: "Smokin BBQ", category: "BBQ", price: "$$" } });
  assert.equal(created.status, 200);
  const id = created.body.vendorId;
  const upd = await post({ c: "tok-o", action: "upsertVendor", vendor: { id, name: "Smokin BBQ Chateau", category: "BBQ", price: "$$$", tagline: "low & slow" } });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.vendorId, id);
  const av = await get("?admin=testadmin");
  const rows = av.body.vendors.filter((x) => x.id === id);
  assert.equal(rows.length, 1); // updated in place, not duplicated
  assert.equal(rows[0].name, "Smokin BBQ Chateau");
  assert.equal(rows[0].price, "$$$");
  const bad = await post({ c: "tok-o", action: "upsertVendor", vendor: { name: "Nope", category: "X", price: "cheap" } });
  assert.equal(bad.status, 400);
});

test("inactive vendors are hidden from the client view but present in admin", async () => {
  const created = await post({ c: "tok-o", action: "upsertVendor", vendor: { name: "Retired Truck", category: "TACOS", price: "$" } });
  const id = created.body.vendorId;
  await post({ c: "tok-o", action: "upsertVendor", vendor: { id, name: "Retired Truck", category: "TACOS", price: "$", active: false } });
  const cv = await get("?c=tok-o");
  assert.equal(cv.body.vendors.find((x) => x.id === id), undefined);
  const av = await get("?admin=testadmin");
  assert.equal(av.body.vendors.find((x) => x.id === id).active, false);
});

test("addBookings batch-inserts, applies time defaults, snapshots vendorName, and validates each", async () => {
  const ven = await post({ c: "tok-o", action: "upsertVendor", vendor: { name: "Taco Truck", category: "TACOS", price: "$$" } });
  const vendorId = ven.body.vendorId;
  const r = await post({
    c: "tok-o", action: "addBookings",
    bookings: [
      { vendorId, date: "2026-07-11" }, // defaults 09:00-17:00
      { vendorId, date: "2026-07-18", startTime: "11:00", endTime: "19:00", note: "first visit!" },
    ],
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.ids.length, 2);
  const cv = await get("?c=tok-o");
  assert.equal(cv.body.bookings.length, 2);
  const b0 = cv.body.bookings.find((b) => b.date === "2026-07-11");
  assert.equal(b0.startTime, "09:00");
  assert.equal(b0.endTime, "17:00");
  assert.equal(b0.vendorId, vendorId);
  assert.equal(b0.vendorName, "Taco Truck"); // denormalized snapshot
  assert.equal(b0.status, "scheduled");
  assert.equal(b0.clientId, "the-o");
  const b1 = cv.body.bookings.find((b) => b.date === "2026-07-18");
  assert.equal(b1.startTime, "11:00");
  assert.equal(b1.endTime, "19:00");
  assert.equal(b1.note, "first visit!");
});

test("addBookings rejects the whole batch if any booking is invalid (unknown vendor / bad time / endTime<startTime / bad date)", async () => {
  const ven = await post({ c: "tok-o", action: "upsertVendor", vendor: { name: "Churro Cart", category: "DESSERTS", price: "$" } });
  const vendorId = ven.body.vendorId;
  // unknown vendor
  assert.equal((await post({ c: "tok-o", action: "addBookings", bookings: [{ vendorId: "ghost", date: "2026-07-11" }] })).status, 400);
  // bad time
  assert.equal((await post({ c: "tok-o", action: "addBookings", bookings: [{ vendorId, date: "2026-07-11", startTime: "25:00" }] })).status, 400);
  // endTime < startTime
  assert.equal((await post({ c: "tok-o", action: "addBookings", bookings: [{ vendorId, date: "2026-07-11", startTime: "17:00", endTime: "09:00" }] })).status, 400);
  // bad date
  assert.equal((await post({ c: "tok-o", action: "addBookings", bookings: [{ vendorId, date: "July 11" }] })).status, 400);
  // nothing was inserted for this vendor (mock store is shared across tests, so
  // scope the assertion to the Churro Cart's own bookings rather than the total).
  const cv = await get("?c=tok-o");
  assert.equal(cv.body.bookings.filter((b) => b.vendorId === vendorId).length, 0);
});

test("renaming a vendor rewrites its bookings' vendorName snapshots (mock parity)", async () => {
  const id = (await post({ c: "tok-o", action: "upsertVendor", vendor: { name: "Smokey Joes", category: "BBQ", price: "$$" } })).body.vendorId;
  const otherId = (await post({ c: "tok-o", action: "upsertVendor", vendor: { name: "Side Cart", category: "DESSERTS", price: "$" } })).body.vendorId;
  await post({ c: "tok-o", action: "addBookings", bookings: [
    { vendorId: id, date: "2026-07-11" },
    { vendorId: id, date: "2026-07-18" },
    { vendorId: otherId, date: "2026-07-11" },
  ] });
  const upd = await post({ c: "tok-o", action: "upsertVendor", vendor: { id, name: "Smokey Joe's BBQ", category: "BBQ", price: "$$" } });
  assert.equal(upd.status, 200);
  // Mock store is shared across tests — scope assertions to this test's vendors.
  const bookings = (await get("?c=tok-o")).body.bookings;
  const renamed = bookings.filter((b) => b.vendorId === id);
  assert.equal(renamed.length, 2);
  for (const b of renamed) assert.equal(b.vendorName, "Smokey Joe's BBQ");
  assert.equal(bookings.find((b) => b.vendorId === otherId).vendorName, "Side Cart");
});

test("addBookings groups a repeat-weekly series under a shared seriesId", async () => {
  const ven = await post({ c: "tok-o", action: "upsertVendor", vendor: { name: "Weekly Truck", category: "TACOS", price: "$" } });
  const vendorId = ven.body.vendorId;
  const r = await post({
    c: "tok-o", action: "addBookings", seriesId: "series-abc",
    bookings: [
      { vendorId, date: "2026-07-07" },
      { vendorId, date: "2026-07-14" },
      { vendorId, date: "2026-07-21" },
    ],
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ids.length, 3);
  const cv = await get("?c=tok-o");
  assert.equal(cv.body.bookings.filter((b) => b.seriesId === "series-abc").length, 3);
});

test("updateBooking merges a patch (time/note/status) and stamps updatedAt", async () => {
  const ven = await post({ c: "tok-o", action: "upsertVendor", vendor: { name: "Edit Truck", category: "BBQ", price: "$$" } });
  const add = await post({ c: "tok-o", action: "addBookings", bookings: [{ vendorId: ven.body.vendorId, date: "2026-07-11" }] });
  const id = add.body.ids[0];
  const before = (await get("?c=tok-o")).body.bookings.find((b) => b.id === id).updatedAt;
  const upd = await post({ c: "tok-o", action: "updateBooking", id, patch: { startTime: "12:00", note: "moved later" } });
  assert.equal(upd.status, 200);
  const row = (await get("?c=tok-o")).body.bookings.find((b) => b.id === id);
  assert.equal(row.startTime, "12:00");
  assert.equal(row.note, "moved later");
  assert.ok(row.updatedAt >= before);
  // cancelling removes it from the client's scheduled view
  const cancel = await post({ c: "tok-o", action: "updateBooking", id, patch: { status: "cancelled" } });
  assert.equal(cancel.status, 200);
  assert.equal((await get("?c=tok-o")).body.bookings.find((b) => b.id === id), undefined);
  // still visible to admin as cancelled
  assert.equal((await get("?admin=testadmin")).body.bookings.find((b) => b.id === id).status, "cancelled");
  // missing id 404s
  assert.equal((await post({ c: "tok-o", action: "updateBooking", id: "bkg_nope", patch: {} })).status, 404);
});

test("deleteBooking removes a single booking by id", async () => {
  const ven = await post({ c: "tok-o", action: "upsertVendor", vendor: { name: "Del Truck", category: "BBQ", price: "$" } });
  const add = await post({ c: "tok-o", action: "addBookings", bookings: [{ vendorId: ven.body.vendorId, date: "2026-07-11" }] });
  const id = add.body.ids[0];
  const del = await post({ c: "tok-o", action: "deleteBooking", id });
  assert.equal(del.status, 200);
  assert.equal((await get("?admin=testadmin")).body.bookings.find((b) => b.id === id), undefined);
  assert.equal((await post({ c: "tok-o", action: "deleteBooking", id: "bkg_nope" })).status, 404);
});

test("deleteBooking by seriesId removes the whole series", async () => {
  const ven = await post({ c: "tok-o", action: "upsertVendor", vendor: { name: "Series Truck", category: "TACOS", price: "$" } });
  const vendorId = ven.body.vendorId;
  await post({ c: "tok-o", action: "addBookings", seriesId: "wipe-me", bookings: [
    { vendorId, date: "2026-09-07" }, { vendorId, date: "2026-09-14" },
  ] });
  const standalone = await post({ c: "tok-o", action: "addBookings", bookings: [{ vendorId, date: "2026-09-21" }] }); // standalone, survives
  const del = await post({ c: "tok-o", action: "deleteBooking", seriesId: "wipe-me" });
  assert.equal(del.status, 200);
  assert.equal(del.body.deleted, 2);
  const av = await get("?admin=testadmin");
  assert.equal(av.body.bookings.filter((b) => b.seriesId === "wipe-me").length, 0);
  assert.equal(av.body.bookings.filter((b) => b.id === standalone.body.ids[0]).length, 1);
});

test("submitRequest stores an optional scheduledFor; bad format rejected (mock parity)", async () => {
  const timed = await post({ c: "tok-o", action: "submitRequest", request: { type: "post", description: "friday night", scheduledFor: "2026-07-24T18:30" } });
  assert.equal(timed.status, 200);
  const av = await get("?admin=testadmin");
  assert.equal(av.body.requests.find((r) => r.id === timed.body.id).scheduledFor, "2026-07-24T18:30");
  const bad = await post({ c: "tok-o", action: "submitRequest", request: { type: "post", description: "x", scheduledFor: "next tuesday" } });
  assert.equal(bad.status, 400);
});

test("clientReviewRequest: approve and changes from ready; guards (mock parity)", async () => {
  const id = (await post({ c: "tok-o", action: "submitRequest", request: { type: "post", description: "client review mock test" } })).body.id;
  for (const a of ["send", "start"]) await post({ admin: "testadmin", action: "updateRequest", id, patch: { action: a } });
  await post({ admin: "testadmin", action: "updateRequest", id, patch: { action: "ready", draft: { caption: "c" } } });
  // changes path first
  const ch = await post({ c: "tok-o", action: "clientReviewRequest", id, verdict: "changes", note: "brighter" });
  assert.equal(ch.status, 200);
  assert.equal(ch.body.request.stage, "changes");
  assert.equal(ch.body.request.changeNote, "brighter");
  assert.equal(ch.body.request.meta.thread.at(-1).text, "brighter");
  // re-stage to ready, then approve
  await post({ admin: "testadmin", action: "updateRequest", id, patch: { action: "start" } });
  await post({ admin: "testadmin", action: "updateRequest", id, patch: { action: "ready", draft: { caption: "c2" } } });
  const ap = await post({ c: "tok-o", action: "clientReviewRequest", id, verdict: "approve" });
  assert.equal(ap.status, 200);
  assert.equal(ap.body.request.stage, "approved");
  assert.equal(ap.body.request.meta.clientReview.verdict, "approve");
  // guards
  assert.equal((await post({ c: "tok-o", action: "clientReviewRequest", id, verdict: "approve" })).status, 409);
  assert.equal((await post({ c: "tok-o", action: "clientReviewRequest", id, verdict: "meh" })).status, 400);
  assert.equal((await post({ action: "clientReviewRequest", id, verdict: "approve" })).status, 403);
  assert.equal((await post({ c: "tok-o", action: "clientReviewRequest", id: "req_nope", verdict: "approve" })).status, 404);
});
