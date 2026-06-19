import { test } from "node:test";
import assert from "node:assert/strict";
import { computeIdeas, buildCampaign, upcomingObservances, prettyDate } from "./ideas.js";

// Fixed reference point: Fri Jun 19, 2026. Father's Day = Sun Jun 21; Fourth = Jul 4.
const NOW = new Date(2026, 5, 19);

test("upcomingObservances finds the near holidays within the window", () => {
  const up = upcomingObservances(NOW, 28);
  const labels = up.map((u) => u.o.label);
  assert.ok(labels.includes("Father's Day"), "Father's Day within 28 days");
  assert.ok(labels.includes("Fourth of July"), "Fourth of July within 28 days");
  const fathers = up.find((u) => u.o.label === "Father's Day");
  assert.equal(fathers.iso, "2026-06-21");
  assert.equal(fathers.days, 2);
});

test("computeIdeas: holidays + posting-gap when there's no activity", () => {
  const ideas = computeIdeas({ requests: [], events: [] }, NOW);
  assert.ok(ideas.length >= 1 && ideas.length <= 3);
  assert.equal(ideas[0].label, "Father's Day"); // nearest holiday ranks first
  assert.ok(ideas.some((i) => i.kind === "gap"), "a posting-gap nudge appears with no requests");
});

test("computeIdeas: an upcoming client event outranks holidays", () => {
  const ideas = computeIdeas({
    requests: [{ createdAt: new Date(2026, 5, 18).toISOString() }],
    events: [{ title: "Live music", date: "2026-06-25", time: "19:00", promoted: false }],
  }, NOW);
  assert.equal(ideas[0].kind, "event");
  assert.match(ideas[0].postIdea, /Live music/);
});

test("buildCampaign expands a holiday idea into a teaser/offer/day-of run", () => {
  const fathers = computeIdeas({ requests: [], events: [] }, NOW).find((i) => i.label === "Father's Day");
  const pack = buildCampaign(fathers);
  assert.equal(pack.length, 3);
  assert.ok(pack.every((p) => p.type === "post"));
  assert.match(pack[0].title, /teaser/);
  assert.match(pack[1].title, /offer/);
  assert.match(pack[2].title, /day of/);
  assert.match(pack[0].description, /June 21/);
});

test("buildCampaign returns nothing for an idea without a campaign", () => {
  assert.deepEqual(buildCampaign({ label: "x" }), []);
  assert.equal(prettyDate("2026-12-25"), "December 25");
});
