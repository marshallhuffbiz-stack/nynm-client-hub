import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveChannels, publishTimes, shipRequest, makeShipper, postsCreateArgs, composeClientLiveMessage } from "./publish.mjs";
import { apiMessage } from "./writeback.mjs";

const NOW = new Date("2026-06-19T17:00:00Z");

const INTEGRATIONS = [
  { id: "ig1", identifier: "instagram", disabled: false, customer: { name: "Eats on 601" } },
  { id: "fb1", identifier: "facebook", disabled: false, customer: { name: "Eats on 601" } },
  { id: "fbO", identifier: "facebook", disabled: false, customer: { name: "The O" } },
  { id: "fbX", identifier: "facebook", disabled: true, customer: { name: "Eats on 601" } },
];

const CLIENT = { clientId: "eats-on-601", name: "Eats on 601" };
const REQ = {
  id: "r1",
  clientId: "eats-on-601",
  type: "post",
  draft: { caption: "hi", artifactPath: "worker/out/r1/post.png", scheduledFor: "" },
};

// --- resolveChannels ---

test("resolveChannels: matches client, drops disabled + other clients, FB before IG", () => {
  const ch = resolveChannels(INTEGRATIONS, "Eats on 601");
  assert.deepEqual(ch.map((c) => c.id), ["fb1", "ig1"]);
});

test("resolveChannels: no match → empty", () => {
  assert.deepEqual(resolveChannels(INTEGRATIONS, "Nobody"), []);
});

test("resolveChannels: trims + case-insensitive, de-dupes per platform", () => {
  const ints = [
    { id: "fb1", identifier: "facebook", disabled: false, customer: { name: "Eats on 601" } },
    { id: "fb2", identifier: "facebook", disabled: false, customer: { name: "Eats on 601" } },
    { id: "ig1", identifier: "instagram", disabled: false, customer: { name: "Eats on 601" } },
  ];
  const ch = resolveChannels(ints, "  eats on 601 "); // trailing space + wrong case
  assert.deepEqual(ch.map((c) => c.identifier), ["facebook", "instagram"]);
  assert.equal(ch.length, 2);
});

test("resolveChannels: blank client name → no channels (fail closed)", () => {
  assert.deepEqual(resolveChannels(INTEGRATIONS, ""), []);
  assert.deepEqual(resolveChannels(INTEGRATIONS, "   "), []);
});

// --- publishTimes ---

test("publishTimes: empty scheduledFor → now+lead, staggered", () => {
  const t = publishTimes(2, { scheduledFor: "", now: NOW, leadMin: 3, staggerMin: 6 });
  assert.deepEqual(t, ["2026-06-19T17:03:00.000Z", "2026-06-19T17:09:00.000Z"]);
});

test("publishTimes: future scheduledFor is the base", () => {
  const t = publishTimes(2, { scheduledFor: "2026-06-19T20:00:00Z", now: NOW });
  assert.deepEqual(t, ["2026-06-19T20:00:00.000Z", "2026-06-19T20:06:00.000Z"]);
});

test("publishTimes: past scheduledFor ignored → now+lead", () => {
  const t = publishTimes(1, { scheduledFor: "2020-01-01T00:00:00Z", now: NOW, leadMin: 3 });
  assert.deepEqual(t, ["2026-06-19T17:03:00.000Z"]);
});

// --- postsCreateArgs (regression guard for the -m/-c flag-corruption bug) ---

test("postsCreateArgs: -c keeps the caption, -m appended (never between -c and its value)", () => {
  const args = postsCreateArgs({ caption: "hello world", mediaUrl: "https://x.png", isoTime: "2026-06-19T17:03:00.000Z", integrationId: "fb1", settings: { post_type: "post" } });
  assert.equal(args[args.indexOf("-c") + 1], "hello world");
  assert.equal(args[args.indexOf("-m") + 1], "https://x.png");
  assert.equal(args[args.indexOf("-i") + 1], "fb1");
  assert.equal(args[args.indexOf("-s") + 1], "2026-06-19T17:03:00.000Z");
  assert.ok(args.includes("schedule"));
  assert.equal(args[args.indexOf("--settings") + 1], '{"post_type":"post"}');
});

test("postsCreateArgs: no media → no -m flag", () => {
  const args = postsCreateArgs({ caption: "hi", isoTime: "t", integrationId: "fb1" });
  assert.ok(!args.includes("-m"));
  assert.equal(args[args.indexOf("-c") + 1], "hi");
});

// --- shipRequest ---

function fakePostiz(opts = {}) {
  const calls = { uploads: [], posts: [] };
  return {
    calls,
    async upload(p) {
      calls.uploads.push(p);
      if (opts.uploadThrows) throw new Error("upload fail");
      return { url: "https://postiz/up.png" };
    },
    async createPost(a) {
      calls.posts.push(a);
      if (opts.postThrows) throw new Error("meta rejected");
      if (opts.failOn && calls.posts.length === opts.failOn) throw new Error("meta rejected on channel " + opts.failOn);
      return { postId: "p" + calls.posts.length };
    },
  };
}

test("shipRequest happy path: uploads local artifact, posts per channel, staggered FB→IG", async () => {
  const pz = fakePostiz();
  const res = await shipRequest(REQ, { client: CLIENT, integrations: INTEGRATIONS, postiz: pz, now: NOW, repoRoot: "/repo" });
  assert.equal(res.ok, true);
  assert.equal(pz.calls.uploads.length, 1);
  assert.match(pz.calls.uploads[0], /\/repo\/worker\/out\/r1\/post\.png$/);
  assert.equal(pz.calls.posts.length, 2);
  assert.equal(pz.calls.posts[0].integrationId, "fb1");
  assert.equal(pz.calls.posts[1].integrationId, "ig1");
  assert.equal(pz.calls.posts[0].isoTime, "2026-06-19T17:03:00.000Z");
  assert.equal(pz.calls.posts[1].isoTime, "2026-06-19T17:09:00.000Z");
  assert.deepEqual(pz.calls.posts[0].settings, { post_type: "post" });
  assert.equal(pz.calls.posts[0].mediaUrl, "https://postiz/up.png");
  assert.deepEqual(res.channels, ["facebook", "instagram"]);
  assert.equal(res.postIds.length, 2);
  assert.equal(res.postIds[0].postId, "p1");
});

test("shipRequest: no channels connected → ok:false, no posts", async () => {
  const pz = fakePostiz();
  const res = await shipRequest({ ...REQ, clientId: "nobody" }, { client: { clientId: "nobody", name: "Nobody" }, integrations: INTEGRATIONS, postiz: pz, now: NOW, repoRoot: "/repo" });
  assert.equal(res.ok, false);
  assert.match(res.error, /No Postiz channels/i);
  assert.equal(pz.calls.posts.length, 0);
});

test("shipRequest: missing media → ok:false", async () => {
  const pz = fakePostiz();
  const res = await shipRequest({ ...REQ, draft: { caption: "hi" } }, { client: CLIENT, integrations: INTEGRATIONS, postiz: pz, now: NOW, repoRoot: "/repo" });
  assert.equal(res.ok, false);
  assert.match(res.error, /image/i);
});

test("shipRequest: a direct http imageUrl is used as-is (no upload)", async () => {
  const pz = fakePostiz();
  const res = await shipRequest({ ...REQ, draft: { caption: "hi", imageUrl: "https://cdn/x.png" } }, { client: CLIENT, integrations: INTEGRATIONS, postiz: pz, now: NOW, repoRoot: "/repo" });
  assert.equal(res.ok, true);
  assert.equal(pz.calls.uploads.length, 0);
  assert.equal(pz.calls.posts[0].mediaUrl, "https://cdn/x.png");
});

test("shipRequest: createPost throws → ok:false with error", async () => {
  const pz = fakePostiz({ postThrows: true });
  const res = await shipRequest(REQ, { client: CLIENT, integrations: INTEGRATIONS, postiz: pz, now: NOW, repoRoot: "/repo" });
  assert.equal(res.ok, false);
  assert.match(res.error, /meta rejected/);
});

test("shipRequest: one channel fails, the other succeeds → ok:true, partial failures, no full abort", async () => {
  const pz = fakePostiz({ failOn: 2 }); // FB (call 1) succeeds, IG (call 2) throws
  const res = await shipRequest(REQ, { client: CLIENT, integrations: INTEGRATIONS, postiz: pz, now: NOW, repoRoot: "/repo" });
  assert.equal(res.ok, true);
  assert.equal(res.postIds.length, 1);
  assert.equal(res.postIds[0].channel, "facebook");
  assert.equal(res.failures.length, 1);
  assert.equal(res.failures[0].channel, "instagram");
});

// --- makeShipper ---

function fakeApi() {
  const patches = [];
  return { patches, async apiUpdate(base, tok, id, patch) { patches.push({ id, patch }); return { ok: true }; } };
}

test("makeShipper: success writes ship→done with postIds + notifies", async () => {
  const api = fakeApi();
  const pz = fakePostiz();
  const notes = [];
  const shipper = makeShipper({
    fetchIntegrations: async () => INTEGRATIONS,
    postiz: pz,
    apiUpdate: api.apiUpdate,
    notifier: { async notifyShipped(x) { notes.push(["ok", x.req.id]); }, async notifyShipFailed(x) { notes.push(["fail", x.req.id]); } },
    now: () => NOW,
    repoRoot: "/repo",
  });
  const res = await shipper({ apiBase: "b", adminToken: "A", ships: [REQ], clients: [CLIENT] });
  assert.deepEqual(res, { shipped: 1, failed: 0, skipped: 0 });
  assert.equal(api.patches[0].patch.action, "ship");
  assert.equal(api.patches[1].patch.action, "done");
  assert.equal(api.patches[1].patch.meta.run.status, "shipped");
  assert.equal(api.patches[1].patch.meta.run.postIds.length, 2);
  assert.deepEqual(notes, [["ok", "r1"]]);
});

test("makeShipper: Postiz failure writes ship→error + notifies", async () => {
  const api = fakeApi();
  const pz = fakePostiz({ postThrows: true });
  const notes = [];
  const shipper = makeShipper({
    fetchIntegrations: async () => INTEGRATIONS,
    postiz: pz,
    apiUpdate: api.apiUpdate,
    notifier: { async notifyShipped() {}, async notifyShipFailed(x) { notes.push(x.error); } },
    now: () => NOW,
    repoRoot: "/repo",
  });
  const res = await shipper({ apiBase: "b", adminToken: "A", ships: [REQ], clients: [CLIENT] });
  assert.deepEqual(res, { shipped: 0, failed: 1, skipped: 0 });
  assert.equal(api.patches[0].patch.action, "ship");
  assert.equal(api.patches[1].patch.action, "error");
  assert.match(api.patches[1].patch.meta.run.error, /meta rejected/);
  assert.equal(notes.length, 1);
});

test("makeShipper: unknown client (not in clients list) → failed, no crash", async () => {
  const api = fakeApi();
  const pz = fakePostiz();
  const shipper = makeShipper({
    fetchIntegrations: async () => INTEGRATIONS,
    postiz: pz,
    apiUpdate: api.apiUpdate,
    notifier: {},
    now: () => NOW,
    repoRoot: "/repo",
  });
  const res = await shipper({ apiBase: "b", adminToken: "A", ships: [{ ...REQ, clientId: "ghost" }], clients: [CLIENT] });
  assert.deepEqual(res, { shipped: 0, failed: 1, skipped: 0 });
});

test("makeShipper: ship-claim writeback fails → skipped, never publishes (no double-post)", async () => {
  const pz = fakePostiz();
  const patches = [];
  const apiUpdate = async (b, t, id, patch) => { patches.push(patch.action); return patch.action === "ship" ? { ok: false } : { ok: true }; };
  const shipper = makeShipper({ fetchIntegrations: async () => INTEGRATIONS, postiz: pz, apiUpdate, notifier: {}, now: () => NOW, repoRoot: "/repo" });
  const res = await shipper({ apiBase: "b", adminToken: "A", ships: [REQ], clients: [CLIENT] });
  assert.deepEqual(res, { shipped: 0, failed: 0, skipped: 1 });
  assert.deepEqual(patches, ["ship"]); // only the failed claim — no done/error, no publish
  assert.equal(pz.calls.posts.length, 0);
});

test("makeShipper: preserves existing meta (thread/activity/notified) on done", async () => {
  const api = fakeApi();
  const pz = fakePostiz();
  const reqWithMeta = { ...REQ, meta: { thread: [{ from: "client", text: "hi" }], activity: [{ kind: "created" }], notified: true } };
  const shipper = makeShipper({ fetchIntegrations: async () => INTEGRATIONS, postiz: pz, apiUpdate: api.apiUpdate, notifier: {}, now: () => NOW, repoRoot: "/repo" });
  await shipper({ apiBase: "b", adminToken: "A", ships: [reqWithMeta], clients: [CLIENT] });
  const done = api.patches.find((p) => p.patch.action === "done");
  assert.ok(done.patch.meta.thread, "thread preserved");
  assert.ok(done.patch.meta.activity, "activity preserved");
  assert.equal(done.patch.meta.notified, true);
  assert.equal(done.patch.meta.run.status, "shipped");
});

test("makeShipper: fetchIntegrations throws (Postiz down) → whole ship lane deferred, rows untouched", async () => {
  const api = fakeApi();
  const pz = fakePostiz();
  const notes = [];
  const shipper = makeShipper({
    fetchIntegrations: async () => { throw new Error("connect ECONNREFUSED"); },
    postiz: pz,
    apiUpdate: api.apiUpdate,
    notifier: { async notifyShipped() {}, async notifyShipFailed(x) { notes.push(x); } },
    now: () => NOW,
    repoRoot: "/repo",
  });
  const res = await shipper({ apiBase: "b", adminToken: "A", ships: [REQ], clients: [CLIENT] });
  assert.equal(res.shipped, 0);
  assert.equal(res.failed, 0, "a Postiz outage is NOT a per-request failure");
  assert.equal(res.skipped, 1);
  assert.equal(res.deferred, true);
  assert.equal(api.patches.length, 0, "no writebacks — rows stay 'approved' and retry next tick");
  assert.equal(pz.calls.posts.length, 0);
  assert.equal(notes.length, 0, "no scary per-request error push for a transient outage");
});

test("makeShipper: publish-side error keeps the draft and tags run.phase='publish' (requeue ships, not re-drafts)", async () => {
  const api = fakeApi();
  const pz = fakePostiz({ postThrows: true });
  const shipper = makeShipper({ fetchIntegrations: async () => INTEGRATIONS, postiz: pz, apiUpdate: api.apiUpdate, notifier: {}, now: () => NOW, repoRoot: "/repo" });
  await shipper({ apiBase: "b", adminToken: "A", ships: [REQ], clients: [CLIENT] });
  const err = api.patches.find((p) => p.patch.action === "error");
  assert.ok(err, "error writeback sent");
  assert.equal(err.patch.meta.run.phase, "publish");
  assert.ok(!("draft" in err.patch), "the approved draft is never wiped by a publish failure");
});

// --- composeClientLiveMessage (client-facing "it's live" thread message) ---

test("composeClientLiveMessage: post on FB+IG → warm, exact copy, no em dashes", () => {
  const msg = composeClientLiveMessage({ type: "post", channels: ["facebook", "instagram"] });
  assert.equal(msg, "Your post is live on Facebook + Instagram. Thanks for sending it our way!");
  assert.ok(!msg.includes("—"), "no em dashes in client-facing copy");
});

test("composeClientLiveMessage: non-post types read sensibly (event-promo → event promo)", () => {
  assert.equal(
    composeClientLiveMessage({ type: "event-promo", channels: ["facebook"] }),
    "Your event promo is live on Facebook. Thanks for sending it our way!"
  );
});

test("composeClientLiveMessage: unknown channels pass through, empty channels → 'social', empty type → 'post'", () => {
  assert.equal(
    composeClientLiveMessage({ type: "post", channels: ["tiktok"] }),
    "Your post is live on tiktok. Thanks for sending it our way!"
  );
  assert.equal(
    composeClientLiveMessage({ type: "", channels: [] }),
    "Your post is live on social. Thanks for sending it our way!"
  );
});

// --- makeShipper: close the client loop on publish ---

test("makeShipper: successful publish posts the good news into the client's request thread", async () => {
  const api = fakeApi();
  const pz = fakePostiz();
  const msgs = [];
  const shipper = makeShipper({
    fetchIntegrations: async () => INTEGRATIONS,
    postiz: pz,
    apiUpdate: api.apiUpdate,
    apiMessage: async (base, tok, id, text) => { msgs.push({ base, tok, id, text }); return { ok: true }; },
    notifier: {},
    now: () => NOW,
    repoRoot: "/repo",
  });
  const res = await shipper({ apiBase: "b", adminToken: "A", ships: [REQ], clients: [CLIENT] });
  assert.equal(res.shipped, 1);
  assert.equal(msgs.length, 1);
  assert.deepEqual(msgs[0], { base: "b", tok: "A", id: "r1", text: "Your post is live on Facebook + Instagram. Thanks for sending it our way!" });
});

test("makeShipper: failed publish posts NO client message", async () => {
  const api = fakeApi();
  const pz = fakePostiz({ postThrows: true });
  const msgs = [];
  const shipper = makeShipper({
    fetchIntegrations: async () => INTEGRATIONS,
    postiz: pz,
    apiUpdate: api.apiUpdate,
    apiMessage: async (...a) => { msgs.push(a); return { ok: true }; },
    notifier: {},
    now: () => NOW,
    repoRoot: "/repo",
  });
  await shipper({ apiBase: "b", adminToken: "A", ships: [REQ], clients: [CLIENT] });
  assert.equal(msgs.length, 0, "the client only hears about SUCCESSFUL publishes");
});

test("makeShipper: a throwing apiMessage is best-effort — the ship still counts and nothing crashes", async () => {
  const api = fakeApi();
  const pz = fakePostiz();
  const shipper = makeShipper({
    fetchIntegrations: async () => INTEGRATIONS,
    postiz: pz,
    apiUpdate: api.apiUpdate,
    apiMessage: async () => { throw new Error("backend hiccup"); },
    notifier: {},
    now: () => NOW,
    repoRoot: "/repo",
  });
  const res = await shipper({ apiBase: "b", adminToken: "A", ships: [REQ], clients: [CLIENT] });
  assert.equal(res.shipped, 1);
  const done = api.patches.find((p) => p.patch.action === "done");
  assert.ok(done, "done writeback unaffected by the failed thread message");
});

test("makeShipper: partial publish messages only the channels that actually went out", async () => {
  const api = fakeApi();
  const pz = fakePostiz({ failOn: 2 }); // FB ok, IG fails
  const msgs = [];
  const shipper = makeShipper({
    fetchIntegrations: async () => INTEGRATIONS,
    postiz: pz,
    apiUpdate: api.apiUpdate,
    apiMessage: async (b, t, id, text) => { msgs.push(text); return { ok: true }; },
    notifier: {},
    now: () => NOW,
    repoRoot: "/repo",
  });
  await shipper({ apiBase: "b", adminToken: "A", ships: [REQ], clients: [CLIENT] });
  assert.deepEqual(msgs, ["Your post is live on Facebook. Thanks for sending it our way!"]);
});

// --- apiMessage (writeback): admin postMessage against the backend contract ---

test("apiMessage POSTs {admin, action:'postMessage', id, text} as JSON", async () => {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { status: 200, json: async () => ({ ok: true }) };
  };
  try {
    const res = await apiMessage("https://api.example/exec", "ADMIN", "req_1", "Your post is live on Facebook. Thanks for sending it our way!");
    assert.equal(res.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.example/exec");
    assert.equal(calls[0].opts.method, "POST");
    assert.equal(calls[0].opts.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(calls[0].opts.body), {
      admin: "ADMIN",
      action: "postMessage",
      id: "req_1",
      text: "Your post is live on Facebook. Thanks for sending it our way!",
    });
  } finally {
    globalThis.fetch = orig;
  }
});

test("makeShipper: retries the done writeback once if it fails (no wedge, still shipped)", async () => {
  const pz = fakePostiz();
  const calls = [];
  const apiUpdate = async (b, t, id, patch) => { calls.push(patch.action); return patch.action === "done" ? { ok: false } : { ok: true }; };
  const shipper = makeShipper({ fetchIntegrations: async () => INTEGRATIONS, postiz: pz, apiUpdate, notifier: {}, now: () => NOW, repoRoot: "/repo" });
  const res = await shipper({ apiBase: "b", adminToken: "A", ships: [REQ], clients: [CLIENT] });
  assert.equal(calls.filter((a) => a === "done").length, 2, "done retried once");
  assert.equal(res.shipped, 1); // the post DID publish, so it still counts shipped
});

// --- F4: request-level scheduledFor falls through when the draft has none ---

test("shipRequest: draft without scheduledFor falls back to req.scheduledFor as the publish base", async () => {
  const calls = [];
  const postiz = {
    upload: async () => ({ url: "https://postiz/img.png" }),
    createPost: async (o) => { calls.push(o); return { postId: `p${calls.length}` }; },
  };
  const req = { ...REQ, scheduledFor: "2026-06-19T20:00:00Z", draft: { ...REQ.draft, scheduledFor: "" } };
  const res = await shipRequest(req, { client: CLIENT, integrations: INTEGRATIONS, postiz, now: NOW });
  assert.equal(res.ok, true);
  assert.equal(calls[0].isoTime, "2026-06-19T20:00:00.000Z"); // fb first, at the requested time
});

test("shipRequest: an explicit draft.scheduledFor still wins over req.scheduledFor", async () => {
  const calls = [];
  const postiz = {
    upload: async () => ({ url: "https://postiz/img.png" }),
    createPost: async (o) => { calls.push(o); return { postId: `p${calls.length}` }; },
  };
  const req = { ...REQ, scheduledFor: "2026-06-19T20:00:00Z", draft: { ...REQ.draft, scheduledFor: "2026-06-19T21:30:00Z" } };
  const res = await shipRequest(req, { client: CLIENT, integrations: INTEGRATIONS, postiz, now: NOW });
  assert.equal(res.ok, true);
  assert.equal(calls[0].isoTime, "2026-06-19T21:30:00.000Z");
});
