import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify, eventKey, etOffset, etIso, dayOfPostIso, isConfident, buildSiteEvent, mergeSiteEvents, mightHaveDate } from "./events-auto.mjs";

const NOW = new Date("2026-06-22T12:00:00Z");

test("slugify: lowercase, hyphenated, alnum only", () => {
  assert.equal(slugify("AP Southern Kitchen!"), "ap-southern-kitchen");
  assert.equal(slugify("  Bella's Sweet  Boutique  "), "bellas-sweet-boutique");
});

test("eventKey: stable across formatting", () => {
  assert.equal(eventKey("eats-on-601", "2026-06-28", "AP Southern Kitchen"), "eats-on-601|2026-06-28|ap-southern-kitchen");
  assert.equal(
    eventKey("eats-on-601", "2026-06-28", "  ap southern kitchen "),
    eventKey("eats-on-601", "2026-06-28", "AP Southern Kitchen")
  );
});

test("etOffset: EDT in summer, EST in winter, correct across DST boundaries", () => {
  assert.equal(etOffset("2026-06-28"), "-04:00"); // June → EDT
  assert.equal(etOffset("2026-01-15"), "-05:00"); // Jan → EST
  assert.equal(etOffset("2026-03-15"), "-04:00"); // after 2nd Sun Mar → EDT
  assert.equal(etOffset("2026-11-15"), "-05:00"); // after 1st Sun Nov → EST
});

test("etIso / dayOfPostIso: 8 AM ET on the event day", () => {
  assert.equal(etIso("2026-06-28", "08:00:00"), "2026-06-28T08:00:00-04:00");
  assert.equal(dayOfPostIso("2026-06-28"), "2026-06-28T08:00:00-04:00");
  assert.equal(dayOfPostIso("2026-12-20"), "2026-12-20T08:00:00-05:00");
});

test("isConfident: needs a title + a valid today-or-future date + not flagged low-confidence", () => {
  const base = { hasDate: true, confident: true, title: "AP Southern Kitchen", ymd: "2026-06-28" };
  assert.equal(isConfident(base, NOW), true);
  assert.equal(isConfident({ ...base, ymd: "2026-06-01" }, NOW), false); // past
  assert.equal(isConfident({ ...base, ymd: "" }, NOW), false); // no date
  assert.equal(isConfident({ ...base, ymd: "next saturday" }, NOW), false); // unparsed
  assert.equal(isConfident({ ...base, confident: false }, NOW), false); // low confidence
  assert.equal(isConfident({ ...base, hasDate: false }, NOW), false);
  assert.equal(isConfident({ ...base, title: "  " }, NOW), false); // no title
  assert.equal(isConfident(null, NOW), false);
});

test("mightHaveDate: catches months/weekdays/relative/numeric, ignores date-less text", () => {
  assert.equal(mightHaveDate("AP Southern Kitchen on the lot Saturday June 28, 11-4"), true);
  assert.equal(mightHaveDate("food truck this weekend"), true);
  assert.equal(mightHaveDate("special on the 28th"), true);
  assert.equal(mightHaveDate("tacos 6/28"), true);
  assert.equal(mightHaveDate("event on 2026-06-28"), true);
  assert.equal(mightHaveDate("Can you make our logo bigger and the hours clearer?"), false);
  assert.equal(mightHaveDate(""), false);
});

test("buildSiteEvent: vendor-day entry with stable id, display date, ISO, meta", () => {
  const e = buildSiteEvent({ title: "AP Southern Kitchen", ymd: "2026-06-28", timeStart: "11 AM", timeEnd: "4 PM", kind: "vendor-day", description: "Southern food on the lot." });
  assert.equal(e.id, "ap-southern-kitchen-2026-06-28");
  assert.equal(e.kind, "vendor-day");
  assert.equal(e.title, "AP Southern Kitchen");
  assert.equal(e.description, "Southern food on the lot.");
  assert.ok(e.isoDate.startsWith("2026-06-28T"), "isoDate is on the event day");
  assert.match(e.date, /Sun · Jun 28/); // 2026-06-28 is a Sunday
  assert.match(e.meta, /FOOD TRUCK/);
  assert.match(e.meta, /11A/);
});

test("buildSiteEvent: defaults kind to vendor-day; 'event' kind labeled EVENT", () => {
  assert.equal(buildSiteEvent({ title: "X", ymd: "2026-07-04" }).kind, "vendor-day");
  const ev = buildSiteEvent({ title: "Jeep Jam", ymd: "2026-07-04", kind: "event" });
  assert.equal(ev.kind, "event");
  assert.match(ev.meta, /EVENT/);
});

test("mergeSiteEvents: appends new, replaces same id in place, idempotent", () => {
  const existing = [{ id: "jeep-jam", title: "Jeep Jam" }];
  const entry = buildSiteEvent({ title: "AP Southern Kitchen", ymd: "2026-06-28" });
  const once = mergeSiteEvents(existing, entry);
  assert.equal(once.length, 2);
  const twice = mergeSiteEvents(once, entry);
  assert.deepEqual(twice, once); // idempotent — no duplicate
  // replace in place
  const updated = { ...entry, description: "changed" };
  const merged = mergeSiteEvents(once, updated);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((e) => e.id === entry.id).description, "changed");
});
