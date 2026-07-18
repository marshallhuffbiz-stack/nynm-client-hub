import { test } from "node:test";
import assert from "node:assert/strict";
import { computeWhatsNew, badgeCount } from "./whatsnew.mjs";

const SEEN = "2026-07-16T12:00:00.000Z";

function payload(requests) {
  return { ok: true, client: { clientId: "the-o" }, requests };
}

test("ready drafts are always surfaced; only fresh ones count toward the badge", () => {
  const data = payload([
    { id: "a", title: "Friday post", stage: "ready", draft: { caption: "c" }, updatedAt: "2026-07-15T09:00:00.000Z" }, // staged BEFORE lastSeen
    { id: "b", title: "Sale post", stage: "ready", draft: { caption: "c" }, updatedAt: "2026-07-17T09:00:00.000Z" },   // staged after
  ]);
  const items = computeWhatsNew(data, SEEN);
  assert.deepEqual(items.map((i) => [i.kind, i.requestId]), [["ready", "b"], ["ready", "a"]]);
  assert.equal(badgeCount(items), 1); // only "b" is new since last visit
});

test("team replies since lastSeen surface (latest per request); client's own messages don't", () => {
  const data = payload([
    { id: "a", title: "Menu post", stage: "queued", meta: { thread: [
      { at: "2026-07-15T09:00:00.000Z", from: "team", text: "old reply" },
      { at: "2026-07-17T09:00:00.000Z", from: "client", text: "mine" },
      { at: "2026-07-17T10:00:00.000Z", from: "team", text: "On it!" },
      { at: "2026-07-17T11:00:00.000Z", from: "team", text: "Done tweaking." },
    ] } },
  ]);
  const items = computeWhatsNew(data, SEEN);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "reply");
  assert.equal(items[0].text, "Done tweaking.");
});

test("published + deployed receipts appear once finished after lastSeen, newest first, capped", () => {
  const reqs = [
    { id: "p", title: "Promo", stage: "done", meta: { run: { finishedAt: "2026-07-17T08:00:00.000Z", channels: ["facebook", "instagram"] } } },
    { id: "w", title: "Hours fix", stage: "done", meta: { run: { finishedAt: "2026-07-17T09:00:00.000Z", liveUrl: "https://eatson601.com" } } },
    { id: "old", title: "Old", stage: "done", meta: { run: { finishedAt: "2026-07-10T09:00:00.000Z", channels: ["facebook"] } } },
  ];
  const items = computeWhatsNew(payload(reqs), SEEN);
  assert.deepEqual(items.map((i) => i.kind), ["deployed", "published"]);
  assert.equal(items[0].liveUrl, "https://eatson601.com");
  assert.deepEqual(items[1].channels, ["facebook", "instagram"]);
  // cap
  const many = Array.from({ length: 10 }, (_, i) => ({
    id: `r${i}`, title: `t${i}`, stage: "done",
    meta: { run: { finishedAt: `2026-07-17T0${Math.min(i, 9)}:30:00.000Z`, channels: ["facebook"] } },
  }));
  assert.equal(computeWhatsNew(payload(many), SEEN).length, 6);
});

test("empty payload / no lastSeen behaves sanely", () => {
  assert.deepEqual(computeWhatsNew(null, ""), []);
  const items = computeWhatsNew(payload([
    { id: "a", title: "x", stage: "done", meta: { run: { finishedAt: "2026-07-17T08:00:00.000Z", channels: ["facebook"] } } },
  ]), ""); // first-ever open: everything is "new"
  assert.equal(items.length, 1);
  assert.equal(badgeCount(items), 1);
});
