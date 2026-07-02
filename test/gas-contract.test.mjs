/**
 * gas-contract.test.mjs — contract tests run against the REAL Apps Script backend
 * (apps-script/Code.gs), executed under Node via test/gas-harness.mjs.
 *
 * Mirrors what test/contract.test.mjs pins against the mock server, so a hand-port
 * drift between mock-server/server.mjs + core/model.mjs and Code.gs shows up here
 * BEFORE a redeploy. Transport note: a GAS web app always replies HTTP 200 — the
 * intended status lives in body.status, so these tests assert on that field where
 * the mock tests assert on the HTTP status line.
 *
 * Each test creates a fresh harness (fresh in-memory spreadsheet seeded from the
 * default fixture: 2 clients — the-o [tok-o, no pin] and eats-on-601 [tok-e,
 * pin 4321] — 2 requests, 1 timed event), so tests are order-independent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, FIXTURE } from "./gas-harness.mjs";

const { ADMIN, TOK_O, TOK_E, PIN_E } = FIXTURE;

/* ============================ doGet: auth + scoping ============================ */

test("admin GET returns everything; bad token 403; missing query 400", () => {
  const h = createHarness();
  const ok = h.get({ admin: ADMIN });
  assert.equal(ok.status, 200);
  assert.equal(ok.clients.length, 2);
  assert.equal(ok.requests.length, 2);
  assert.equal(ok.events.length, 1);
  assert.equal(h.get({ admin: "nope" }).status, 403);
  assert.equal(h.get({}).status, 400);
});

test("client GET scoped to own tenant, secrets stripped; bad link 403", () => {
  const h = createHarness();
  const ok = h.get({ client: TOK_O });
  assert.equal(ok.status, 200);
  assert.equal(ok.client.name, "The O");
  assert.equal(ok.client.token, undefined); // secrets stripped
  assert.equal(ok.client.pin, undefined);
  assert.ok(ok.requests.every((r) => r.clientId === "the-o"));
  assert.equal(ok.requests.length, 1); // does NOT see eats-on-601's request
  assert.equal(ok.events.length, 1);
  // ?c= alias accepted too (mock's param name)
  assert.equal(h.get({ c: TOK_O }).status, 200);
  assert.equal(h.get({ c: "wrong" }).status, 403);
});

test("pin gate: 401 needPin without pin, 200 with the right one", () => {
  const h = createHarness();
  const noPin = h.get({ client: TOK_E });
  assert.equal(noPin.status, 401);
  assert.equal(noPin.needPin, true);
  assert.equal(h.get({ client: TOK_E, pin: "0000" }).status, 401);
  const ok = h.get({ client: TOK_E, pin: PIN_E });
  assert.equal(ok.status, 200);
  assert.equal(ok.client.hasPin, true);
});

/* ============================ submitRequest ============================ */

test("submitRequest creates a submitted request; spoofed clientId is overridden by the token's tenant", () => {
  const h = createHarness();
  const r = h.post({
    c: TOK_O,
    action: "submitRequest",
    // tenant spoof attempt: client token tok-o tries to plant into eats-on-601
    request: { type: "post", description: "Promote our Friday sidewalk sale", clientId: "eats-on-601" },
  });
  assert.equal(r.status, 200);
  assert.ok(r.id);
  const av = h.get({ admin: ADMIN });
  const rec = av.requests.find((x) => x.id === r.id);
  assert.equal(rec.clientId, "the-o"); // spoof blocked: forced to the auth'd tenant
  assert.equal(rec.stage, "submitted");
  assert.equal(rec.meta.activity[0].kind, "created");
  // and eats-on-601's portal view never sees it
  const ev = h.get({ client: TOK_E, pin: PIN_E });
  assert.equal(ev.requests.find((x) => x.id === r.id), undefined);
});

test("submitRequest validation: bad type / missing description 400; no auth 403", () => {
  const h = createHarness();
  const bad = h.post({ c: TOK_O, action: "submitRequest", request: { type: "carrier-pigeon", description: "" } });
  assert.equal(bad.status, 400);
  assert.ok(bad.errors.some((e) => /type must be one of/.test(e)));
  assert.ok(bad.errors.some((e) => /description required/.test(e)));
  const noAuth = h.post({ action: "submitRequest", request: { type: "post", description: "x" } });
  assert.equal(noAuth.status, 403);
});

test("submitRequest idempotency: same clientRequestId returns the original id, no duplicate row", () => {
  const h = createHarness();
  const first = h.post({
    c: TOK_O, action: "submitRequest", clientRequestId: "cli_retry_1",
    request: { type: "post", description: "flaky network retry test" },
  });
  assert.equal(first.status, 200);
  const retry = h.post({
    c: TOK_O, action: "submitRequest", clientRequestId: "cli_retry_1",
    request: { type: "post", description: "flaky network retry test" },
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.id, first.id);
  assert.equal(retry.deduped, true);
  const av = h.get({ admin: ADMIN });
  assert.equal(av.requests.filter((r) => r.meta.clientRequestId === "cli_retry_1").length, 1);
});

/* ============================ POST auth boundaries ============================ */

test("client cannot hit admin actions; unknown action 400", () => {
  const h = createHarness();
  assert.equal(h.post({ c: TOK_O, action: "updateRequest", id: "req_theo_1", patch: {} }).status, 403);
  assert.equal(h.post({ c: TOK_O, action: "deleteRequest", id: "req_theo_1" }).status, 403);
  assert.equal(h.post({ c: TOK_O, action: "promoteEvent", eventId: "evt_theo_1" }).status, 403);
  assert.equal(h.post({ c: TOK_O, action: "upsertClient", client: { clientId: "evil" } }).status, 403);
  assert.equal(h.post({ admin: ADMIN, action: "definitely-not-a-thing" }).status, 400);
});

test("tenant spoof-block: a client cannot postMessage on another client's request", () => {
  const h = createHarness();
  const spoof = h.post({ c: TOK_O, action: "postMessage", id: "req_eats_1", text: "let me in" });
  assert.equal(spoof.status, 403);
  // ...but the owning client can
  const own = h.post({ c: TOK_E, action: "postMessage", id: "req_eats_1", text: "any update?" });
  assert.equal(own.status, 200);
  assert.equal(own.request.meta.thread.at(-1).from, "client");
});

/* ============================ stage machine ============================ */

test("full stage machine: send -> start -> ready -> approve -> ship -> done", () => {
  const h = createHarness();
  const id = h.post({ c: TOK_O, action: "submitRequest", request: { type: "design", description: "new menu graphic" } }).id;
  const send = h.post({ admin: ADMIN, action: "updateRequest", id, patch: { action: "send", comment: "make it pop" } });
  assert.equal(send.request.stage, "queued");
  assert.equal(send.request.comment, "make it pop");
  assert.equal(h.post({ admin: ADMIN, action: "updateRequest", id, patch: { action: "start" } }).request.stage, "drafting");
  const ready = h.post({ admin: ADMIN, action: "updateRequest", id, patch: { action: "ready", draft: { caption: "hi" } } });
  assert.equal(ready.request.stage, "ready");
  assert.deepEqual(ready.request.draft, { caption: "hi" });
  assert.equal(h.post({ admin: ADMIN, action: "updateRequest", id, patch: { action: "approve" } }).request.stage, "approved");
  assert.equal(h.post({ admin: ADMIN, action: "updateRequest", id, patch: { action: "ship" } }).request.stage, "shipping");
  const done = h.post({ admin: ADMIN, action: "updateRequest", id, patch: { action: "done" } });
  assert.equal(done.request.stage, "done");
  // every action is audit-logged
  const kinds = done.request.meta.activity.map((a) => a.kind);
  for (const k of ["created", "send", "start", "ready", "approve", "ship", "done"]) assert.ok(kinds.includes(k), k);
});

test("illegal transition rejected with 409; missing id 404", () => {
  const h = createHarness();
  const bad = h.post({ admin: ADMIN, action: "updateRequest", id: "req_theo_1", patch: { action: "approve" } });
  assert.equal(bad.status, 409);
  assert.match(bad.error, /illegal transition/);
  assert.equal(h.post({ admin: ADMIN, action: "updateRequest", id: "req_nope", patch: {} }).status, 404);
});

/* ============================ events + promotion ============================ */

test("addEvent stores time/endTime and round-trips them; bad time/endTime/date 400", () => {
  const h = createHarness();
  const ev = h.post({ c: TOK_O, action: "addEvent", event: { title: "Trivia night", date: "2026-07-10", time: "19:30", endTime: "21:00" } });
  assert.equal(ev.status, 200);
  const row = h.get({ client: TOK_O }).events.find((e) => e.eventId === ev.eventId);
  assert.equal(row.time, "19:30");
  assert.equal(row.endTime, "21:00");
  assert.equal(h.post({ c: TOK_O, action: "addEvent", event: { title: "x", date: "2026-07-10", time: "25:99" } }).status, 400);
  assert.equal(h.post({ c: TOK_O, action: "addEvent", event: { title: "x", date: "2026-07-10", endTime: "26:00" } }).status, 400);
  assert.equal(h.post({ c: TOK_O, action: "addEvent", event: { title: "x", date: "July 10th" } }).status, 400);
});

test("promoteEvent flags the event, links the request, and carries 12-hour times into the description", () => {
  const h = createHarness();
  // seeded event: Wine tasting 2026-07-18 19:00-22:00
  const promo = h.post({ admin: ADMIN, action: "promoteEvent", eventId: "evt_theo_1" });
  assert.equal(promo.status, 200);
  const av = h.get({ admin: ADMIN });
  const evRow = av.events.find((e) => e.eventId === "evt_theo_1");
  assert.equal(evRow.promoted, true);
  assert.equal(evRow.requestId, promo.requestId);
  const req = av.requests.find((r) => r.id === promo.requestId);
  assert.equal(req.type, "event-promo");
  assert.equal(req.eventId, "evt_theo_1");
  assert.match(req.description, /Wine tasting on 2026-07-18/);
  assert.match(req.description, /7:00 PM–10:00 PM/);
  assert.match(req.description, /five pours/);
  // missing event 404
  assert.equal(h.post({ admin: ADMIN, action: "promoteEvent", eventId: "evt_nope" }).status, 404);
});

test("promoteEvent with only a start time says 'starting ...'", () => {
  const h = createHarness();
  const ev = h.post({ c: TOK_O, action: "addEvent", event: { title: "Open mic", date: "2026-07-12", time: "18:30" } });
  const promo = h.post({ admin: ADMIN, action: "promoteEvent", eventId: ev.eventId });
  const req = h.get({ admin: ADMIN }).requests.find((r) => r.id === promo.requestId);
  assert.match(req.description, /starting 6:30 PM/);
});

/* ============================ meta deep-merge ============================ */

test("a meta patch merges instead of clobbering (thread + activity + idempotency key survive)", () => {
  const h = createHarness();
  const id = h.post({
    c: TOK_O, action: "submitRequest", clientRequestId: "cli_merge_1",
    request: { type: "post", description: "meta merge test" },
  }).id;
  // a client message lands after the worker's fetch...
  h.post({ c: TOK_O, action: "postMessage", id, text: "Actually make it blue" });
  // ...then a worker writeback patches only meta.run
  const wb = h.post({ admin: ADMIN, action: "updateRequest", id, patch: { meta: { run: { phase: "draft", error: "render failed" } } } });
  assert.equal(wb.status, 200);
  const m = wb.request.meta;
  assert.equal(m.run.error, "render failed");
  assert.equal(m.thread.length, 1); // client message survived
  assert.equal(m.thread[0].text, "Actually make it blue");
  assert.equal(m.clientRequestId, "cli_merge_1"); // idempotency key survived
  assert.ok(m.activity.some((a) => a.kind === "created")); // audit trail survived
});

test("an action patch carrying stale meta keeps the server's activity entry, no duplicates", () => {
  const h = createHarness();
  const id = h.post({ c: TOK_O, action: "submitRequest", request: { type: "post", description: "activity keep test" } }).id;
  const stale = h.get({ admin: ADMIN }).requests.find((r) => r.id === id).meta;
  const send = h.post({ admin: ADMIN, action: "updateRequest", id, patch: { action: "send", meta: { ...stale, notified: true } } });
  assert.equal(send.status, 200);
  const m = send.request.meta;
  assert.equal(m.notified, true); // the delta landed
  const kinds = m.activity.map((a) => a.kind);
  assert.ok(kinds.includes("created"));
  assert.ok(kinds.includes("send")); // the entry the server just appended was NOT dropped
  assert.equal(m.activity.filter((a) => a.kind === "created").length, 1); // union, not duplicate
});

/* ============================ requeue ============================ */

test("requeue after a publish failure returns to approved KEEPING the draft", () => {
  const h = createHarness();
  const id = h.post({ c: TOK_O, action: "submitRequest", request: { type: "post", description: "publish retry test" } }).id;
  for (const a of ["send", "start"]) h.post({ admin: ADMIN, action: "updateRequest", id, patch: { action: a } });
  h.post({ admin: ADMIN, action: "updateRequest", id, patch: { action: "ready", draft: { caption: "approved creative" } } });
  for (const a of ["approve", "ship"]) h.post({ admin: ADMIN, action: "updateRequest", id, patch: { action: a } });
  const err = h.post({ admin: ADMIN, action: "updateRequest", id, patch: { action: "error", meta: { run: { phase: "publish", error: "Postiz 502" } } } });
  assert.equal(err.request.stage, "error");
  const rq = h.post({ admin: ADMIN, action: "updateRequest", id, patch: { action: "requeue" } });
  assert.equal(rq.status, 200);
  assert.equal(rq.request.stage, "approved");
  assert.deepEqual(rq.request.draft, { caption: "approved creative" }); // draft KEPT
  assert.equal(rq.request.meta.run.error, ""); // stale error cleared
  assert.ok(rq.request.meta.activity.some((a) => a.kind === "requeue")); // audit-logged
});

test("requeue of a draft-phase failure re-queues fresh; rescues stuck shipping; 409 elsewhere", () => {
  const h = createHarness();
  // draft-phase failure -> queued, draft cleared
  const a = h.post({ c: TOK_O, action: "submitRequest", request: { type: "post", description: "draft retry test" } }).id;
  for (const act of ["send", "start"]) h.post({ admin: ADMIN, action: "updateRequest", id: a, patch: { action: act } });
  h.post({ admin: ADMIN, action: "updateRequest", id: a, patch: { action: "error", meta: { run: { phase: "draft", error: "render crashed" } } } });
  const rqA = h.post({ admin: ADMIN, action: "updateRequest", id: a, patch: { action: "requeue" } });
  assert.equal(rqA.request.stage, "queued");
  assert.equal(rqA.request.draft, null);

  // requeue is illegal from submitted
  const b = h.post({ c: TOK_O, action: "submitRequest", request: { type: "post", description: "stuck shipping test" } }).id;
  assert.equal(h.post({ admin: ADMIN, action: "updateRequest", id: b, patch: { action: "requeue" } }).status, 409);

  // stuck shipping row (publish phase, draft present) -> approved, draft kept
  for (const act of ["send", "start"]) h.post({ admin: ADMIN, action: "updateRequest", id: b, patch: { action: act } });
  h.post({ admin: ADMIN, action: "updateRequest", id: b, patch: { action: "ready", draft: { caption: "c" } } });
  for (const act of ["approve", "ship"]) h.post({ admin: ADMIN, action: "updateRequest", id: b, patch: { action: act } });
  h.post({ admin: ADMIN, action: "updateRequest", id: b, patch: { meta: { run: { phase: "publish" } } } });
  const rqB = h.post({ admin: ADMIN, action: "updateRequest", id: b, patch: { action: "requeue" } });
  assert.equal(rqB.request.stage, "approved");
  assert.deepEqual(rqB.request.draft, { caption: "c" });
});

/* ============================ postMessage thread ============================ */

test("postMessage threads client + team replies; empty 400; missing 404", () => {
  const h = createHarness();
  const id = h.post({ c: TOK_O, action: "submitRequest", request: { type: "post", description: "thread test" } }).id;
  const m1 = h.post({ c: TOK_O, action: "postMessage", id, text: "Can you make it brighter?" });
  assert.equal(m1.status, 200);
  assert.equal(m1.request.meta.thread.length, 1);
  assert.equal(m1.request.meta.thread[0].from, "client");
  const m2 = h.post({ admin: ADMIN, action: "postMessage", id, text: "On it." });
  assert.equal(m2.request.meta.thread.at(-1).from, "team");
  assert.equal(h.post({ admin: ADMIN, action: "postMessage", id, text: "   " }).status, 400);
  assert.equal(h.post({ admin: ADMIN, action: "postMessage", id: "req_nope", text: "hi" }).status, 404);
});

/* ============================ uploads ============================ */

test("uploadAttachment: 413 guard on oversized base64; small file lands in Drive with a url", () => {
  const h = createHarness();
  const big = h.post({ c: TOK_O, action: "uploadAttachment", file: { name: "huge.jpg", mime: "image/jpeg", dataBase64: "x".repeat(10_000_001) } });
  assert.equal(big.status, 413);
  assert.match(big.error, /too large/);

  const b64 = Buffer.from("hello-pixels").toString("base64");
  const up = h.post({ c: TOK_O, action: "uploadAttachment", file: { name: "shot.txt", mime: "text/plain", dataBase64: b64 } });
  assert.equal(up.status, 200);
  assert.match(up.url, /drive\.google\.com/);
  assert.equal(up.name, "shot.txt");
  assert.equal(up.mime, "text/plain");
  // the REAL bytes made it through Utilities.base64Decode -> newBlob -> createFile
  assert.equal(h.drive.files.length, 1);
  assert.equal(Buffer.from(h.drive.files[0].blob.getBytes()).toString(), "hello-pixels");
  // upload without any auth is rejected
  assert.equal(h.post({ action: "uploadAttachment", file: { name: "x", dataBase64: b64 } }).status, 403);
});

/* ============================ deleteRequest + upsertClient ============================ */

test("deleteRequest removes the row (admin only); 404 for a missing id", () => {
  const h = createHarness();
  const del = h.post({ admin: ADMIN, action: "deleteRequest", id: "req_theo_1" });
  assert.equal(del.status, 200);
  assert.equal(del.deleted, true);
  const av = h.get({ admin: ADMIN });
  assert.equal(av.requests.find((r) => r.id === "req_theo_1"), undefined);
  assert.equal(av.requests.length, 1); // the other tenant's row untouched
  assert.equal(h.post({ admin: ADMIN, action: "deleteRequest", id: "req_nope" }).status, 404);
});

test("upsertClient mints a token; deactivating a client kills their portal link", () => {
  const h = createHarness();
  const created = h.post({ admin: ADMIN, action: "upsertClient", client: { clientId: "maple-vine", name: "Maple & Vine" } });
  assert.equal(created.status, 200);
  assert.ok(created.token.length >= 24);
  // the fresh token works on the portal GET
  const view = h.get({ client: created.token });
  assert.equal(view.status, 200);
  assert.equal(view.client.name, "Maple & Vine");
  // deactivate -> portal link goes dead
  const off = h.post({ admin: ADMIN, action: "upsertClient", client: { clientId: "maple-vine", active: false } });
  assert.equal(off.status, 200);
  assert.equal(off.token, created.token); // token stable across upsert
  assert.equal(h.get({ client: created.token }).status, 403);
  // missing clientId 400
  assert.equal(h.post({ admin: ADMIN, action: "upsertClient", client: {} }).status, 400);
});

/* ============================ V9: Sheets cell-coercion recovery ============================ */

test("time/date cells Sheets coerced into Date objects still read back as HH:MM / YYYY-MM-DD", () => {
  const h = createHarness();
  // Simulate Sheets having coerced the seeded event's cells: overwrite raw cells
  // with Date objects (what GAS getValues() returns for time/date-typed cells)
  // and a seconds-bearing time string. Sheet tz is America/New_York (EDT in July).
  const sheet = h.sheets.get("Events");
  const header = sheet.rows[0];
  const row = sheet.rows[1]; // seeded evt_theo_1
  row[header.indexOf("time")] = new Date("2026-07-18T19:00:00-04:00"); // wall-clock 19:00 in sheet tz
  row[header.indexOf("endTime")] = "22:00:00"; // Sheets duration-style string
  row[header.indexOf("date")] = new Date("2026-07-18T00:00:00-04:00");
  const ev = h.get({ client: TOK_O }).events.find((e) => e.eventId === "evt_theo_1");
  assert.equal(ev.time, "19:00");
  assert.equal(ev.endTime, "22:00");
  assert.equal(ev.date, "2026-07-18");
  // ...and promoteEvent built from those coerced cells still renders 12-hour copy
  const promo = h.post({ admin: ADMIN, action: "promoteEvent", eventId: "evt_theo_1" });
  const req = h.get({ admin: ADMIN }).requests.find((r) => r.id === promo.requestId);
  assert.match(req.description, /7:00 PM–10:00 PM/);
});

/* ============================ harness self-check ============================ */

test("harness is strict: an unstubbed GAS API fails loudly, never silently", () => {
  const h = createHarness();
  assert.throws(() => h.stubs.Utilities.sleep(1), /not implemented/);
  assert.throws(() => h.stubs.SpreadsheetApp.flush(), /not implemented/);
});
