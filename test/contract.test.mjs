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
