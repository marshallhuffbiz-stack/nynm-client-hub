// ntfy push headers: every notification deep-links to the Desk, failures are urgent.
import test from "node:test";
import assert from "node:assert/strict";
import { ntfyHeaders, pushNotify, DESK_URL } from "./notify.mjs";

test("every ntfy push deep-links to the Desk via Click, normal priority by default", () => {
  const h = ntfyHeaders("New client request");
  assert.equal(h.Title, "New client request");
  assert.equal(h.Click, DESK_URL);
  assert.equal(h.Priority, undefined); // ntfy default priority — no header sent
  assert.equal(h.Tags, undefined);
});

test("urgent pushes (publish failed / worker paused) get high priority + a warning tag", () => {
  const h = ntfyHeaders("Relay — publish failed", { urgent: true });
  assert.equal(h.Click, DESK_URL);
  assert.equal(h.Priority, "high");
  assert.equal(h.Tags, "warning");
});

test("an explicit priority/tags (the loud new-request push) overrides the urgent default", () => {
  const h = ntfyHeaders("New client request", { priority: "max", tags: "bell" });
  assert.equal(h.Priority, "max");
  assert.equal(h.Tags, "bell");
});

test("the Desk deep-link carries no admin key; click + extra headers are overridable", () => {
  assert.ok(!DESK_URL.includes("?"), "no query string (no ?k= token) in the push channel");
  const h = ntfyHeaders("t", { click: "https://example.com/desk/", extra: { Authorization: "Bearer x" } });
  assert.equal(h.Click, "https://example.com/desk/");
  assert.equal(h.Authorization, "Bearer x");
});

test("pushNotify wires Click/Priority into the ntfy request (and honors config.push.click)", async () => {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return { ok: true }; };
  try {
    await pushNotify({ mode: "ntfy", url: "https://ntfy.sh/topic" }, "Relay — publish failed", "boom", { urgent: true });
    await pushNotify({ mode: "ntfy", url: "https://ntfy.sh/topic", click: "https://me.example/desk/" }, "New client request", "hi");
  } finally {
    globalThis.fetch = orig;
  }
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.headers.Click, DESK_URL);
  assert.equal(calls[0].init.headers.Priority, "high");
  assert.equal(calls[0].init.headers.Tags, "warning");
  assert.equal(calls[0].init.body, "boom");
  assert.equal(calls[1].init.headers.Click, "https://me.example/desk/");
  assert.equal(calls[1].init.headers.Priority, undefined);
});

test("notifyNew pushes at max priority with a bell so a new submission makes sound on iOS", async () => {
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true }; };
  try {
    const { makeNotifier } = await import("./notify.mjs");
    const n = makeNotifier({ push: { mode: "ntfy", url: "https://ntfy.sh/t" } });
    await n.notifyNew({ clientId: "the-o", title: "New flyer" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.headers.Title, "New client request");
    assert.equal(calls[0].opts.headers.Priority, "max");
    assert.equal(calls[0].opts.headers.Tags, "bell");
    assert.match(String(calls[0].opts.body), /the-o: New flyer/);
  } finally { globalThis.fetch = origFetch; }
});

test("notifyReady pushes a review prompt with client + title", async () => {
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true }; };
  try {
    const { makeNotifier } = await import("./notify.mjs");
    const n = makeNotifier({ push: { mode: "ntfy", url: "https://ntfy.sh/t" } });
    await n.notifyReady({ clientId: "eats-on-601", title: "July calendar" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.headers.Title, "Draft ready for your review");
    assert.match(String(calls[0].opts.body), /eats-on-601: "July calendar"/);
  } finally { globalThis.fetch = origFetch; }
});
