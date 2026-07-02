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
