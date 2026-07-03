import { test } from "node:test";
import assert from "node:assert/strict";
import { noteFor, flattenHistory, searchHistory } from "./history.mjs";

// ---- noteFor: the _note text the worker attaches to each stage transition ----

test("noteFor start names the host so Mac vs VPS work is distinguishable", () => {
  assert.equal(noteFor("start", { host: "vps-postiz" }), "Drafting started on vps-postiz");
});

test("noteFor ready carries the draft summary (trimmed) and channel", () => {
  const n = noteFor("ready", {
    host: "vps",
    draft: { summary: "Old Fashioned $8 promo, badge-seal template, fresh photo", channel: "instagram" },
  });
  assert.match(n, /Draft staged/);
  assert.match(n, /instagram/);
  assert.match(n, /Old Fashioned \$8 promo/);
});

test("noteFor ready falls back to caption, trims long text, survives no draft", () => {
  const long = "x".repeat(500);
  const n = noteFor("ready", { host: "vps", draft: { caption: long } });
  assert.ok(n.length < 300, "trimmed");
  assert.equal(noteFor("ready", { host: "vps" }), "Draft staged");
});

test("noteFor done/ship/error", () => {
  assert.equal(noteFor("ship", { host: "vps" }), "Publish started on vps");
  assert.match(noteFor("done", { host: "vps" }), /Published/);
  assert.match(noteFor("error", { message: "render blew up" }), /render blew up/);
});

// ---- flattenHistory: one searchable timeline across every request ----

const CLIENTS = [
  { id: "c1", name: "The O" },
  { id: "c2", name: "Eats on 601" },
];
const REQS = [
  {
    id: "r1", clientId: "c1", title: "Old Fashioned promo", stage: "ready", updatedAt: "2026-07-02T15:00:00Z",
    draft: { caption: "The Old Fashioned. Eight dollars, every day.", summary: "badge-seal render" },
    meta: {
      activity: [
        { at: "2026-07-02T14:00:00Z", kind: "created", text: "submitted via portal" },
        { at: "2026-07-02T14:30:00Z", kind: "ready", text: "Draft staged for instagram — badge-seal render" },
      ],
      thread: [{ at: "2026-07-02T14:10:00Z", from: "client", text: "make it moody please" }],
    },
  },
  {
    id: "r2", clientId: "c2", title: "Jeep Jam day-of post", stage: "done", updatedAt: "2026-07-01T10:00:00Z",
    changeNote: "less text on the image",
    meta: { activity: [{ at: "2026-07-01T09:00:00Z", kind: "done", text: "Published" }] },
  },
];

test("flattenHistory merges activity + thread + draft + changeNote, newest first, with client names", () => {
  const entries = flattenHistory(REQS, CLIENTS);
  assert.ok(entries.length >= 5, "activity(3) + thread(1) + draft(1) + changeNote(1)");
  const kinds = new Set(entries.map((e) => e.kind));
  for (const k of ["created", "ready", "message", "draft", "change-note"]) assert.ok(kinds.has(k), "has " + k);
  // newest first
  const times = entries.map((e) => e.at);
  assert.deepEqual(times, [...times].sort().reverse(), "sorted desc");
  const r1 = entries.find((e) => e.kind === "ready");
  assert.equal(r1.clientName, "The O");
  assert.equal(r1.title, "Old Fashioned promo");
});

test("flattenHistory survives missing meta/clients and non-array garbage", () => {
  const entries = flattenHistory([{ id: "x", title: "bare", meta: { activity: "junk" } }], null);
  assert.ok(Array.isArray(entries));
});

// ---- searchHistory: multi-word AND filter over everything visible ----

test("searchHistory finds entries by draft text, client name, and kind; AND semantics", () => {
  const entries = flattenHistory(REQS, CLIENTS);
  assert.ok(searchHistory(entries, "old fashioned").length >= 2, "matches draft + activity text");
  assert.ok(searchHistory(entries, "eats jeep").every((e) => e.clientId === "c2"), "AND across client+title");
  assert.equal(searchHistory(entries, "zebra unicorn").length, 0);
  assert.equal(searchHistory(entries, "").length, entries.length, "empty query = everything");
  assert.ok(searchHistory(entries, "moody").some((e) => e.kind === "message"), "thread messages searchable");
});
