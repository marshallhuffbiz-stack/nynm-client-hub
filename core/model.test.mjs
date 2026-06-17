import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REQUEST_TYPES,
  STAGES,
  validateRequestInput,
  validateEventInput,
  nextStage,
  routeSkill,
  shouldNotify,
  digestSummary,
  publicClient,
  validatePin,
  mergePatch,
  isStale,
} from "./model.mjs";
import { genId, genToken } from "./ids.mjs";

test("REQUEST_TYPES + STAGES are defined", () => {
  assert.deepEqual(REQUEST_TYPES, ["post", "website", "design", "event-promo"]);
  assert.ok(STAGES.includes("submitted"));
  assert.ok(STAGES.includes("done"));
});

test("validateRequestInput accepts a good post request and derives a title", () => {
  const r = validateRequestInput({
    clientId: "the-o",
    type: "post",
    description: "Promote our Friday sidewalk sale, 20% off everything",
    attachments: [],
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.type, "post");
  assert.ok(r.value.title.length > 0);
  assert.equal(r.value.clientId, "the-o");
  assert.equal(r.value.eventId, "");
});

test("validateRequestInput rejects bad type + empty description", () => {
  const r = validateRequestInput({ clientId: "the-o", type: "nope", description: "" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 2);
});

test("validateRequestInput rejects non-array attachments", () => {
  const r = validateRequestInput({ clientId: "x", type: "post", description: "hi", attachments: "oops" });
  assert.equal(r.ok, false);
});

test("validateEventInput", () => {
  assert.equal(validateEventInput({ clientId: "the-o", title: "Live music", date: "2026-07-04", description: "patio" }).ok, true);
  assert.equal(validateEventInput({ clientId: "the-o", title: "", date: "2026-07-04" }).ok, false);
  assert.equal(validateEventInput({ clientId: "the-o", title: "x", date: "nope" }).ok, false);
});

test("nextStage legal transitions", () => {
  assert.equal(nextStage("submitted", "send"), "queued");
  assert.equal(nextStage("queued", "start"), "drafting");
  assert.equal(nextStage("drafting", "ready"), "ready");
  assert.equal(nextStage("ready", "approve"), "approved");
  assert.equal(nextStage("approved", "ship"), "shipping");
  assert.equal(nextStage("shipping", "done"), "done");
  assert.equal(nextStage("ready", "requestChanges"), "changes");
  assert.equal(nextStage("changes", "start"), "drafting");
  assert.equal(nextStage("error", "start"), "drafting");
  assert.equal(nextStage("drafting", "error"), "error");
});

test("nextStage illegal transition throws", () => {
  assert.throws(() => nextStage("submitted", "approve"));
  assert.throws(() => nextStage("done", "send"));
});

test("routeSkill maps each type", () => {
  assert.equal(routeSkill("post").skill, "branded-social-post");
  assert.equal(routeSkill("event-promo").skill, "branded-social-post");
  assert.equal(routeSkill("website").skill, "site-edit");
  assert.equal(routeSkill("design", "make a quote card").skill, "branded-social-post");
  assert.equal(routeSkill("design", "a photo of a latte on a wooden table").skill, "imagery");
  assert.equal(routeSkill("design", "draft a one-pager proposal").skill, "branded-collateral");
});

test("shouldNotify on new submit + error only", () => {
  assert.equal(shouldNotify(null, "submitted"), true);
  assert.equal(shouldNotify("shipping", "error"), true);
  assert.equal(shouldNotify("submitted", "queued"), false);
  assert.equal(shouldNotify("ready", "approved"), false);
});

test("digestSummary counts open work", () => {
  const reqs = [
    { stage: "submitted", clientId: "the-o", type: "post", title: "a" },
    { stage: "ready", clientId: "eats", type: "design", title: "b" },
    { stage: "done", clientId: "and", type: "post", title: "c" },
  ];
  const d = digestSummary(reqs);
  assert.equal(d.open, 2);
  assert.equal(d.byStage.submitted, 1);
  assert.equal(d.lines.length, 2);
});

test("publicClient strips secrets", () => {
  const pc = publicClient({ clientId: "the-o", name: "The O", token: "secret", pin: "1234", brandSlug: "the-o" });
  assert.equal(pc.token, undefined);
  assert.equal(pc.pin, undefined);
  assert.equal(pc.brandSlug, undefined);
  assert.equal(pc.name, "The O");
  assert.equal(pc.hasPin, true);
});

test("validatePin", () => {
  assert.equal(validatePin({ pin: "" }, ""), true);
  assert.equal(validatePin({ pin: "1234" }, "1234"), true);
  assert.equal(validatePin({ pin: "1234" }, "0000"), false);
  assert.equal(validatePin({ pin: "1234" }, undefined), false);
});

test("mergePatch overlays fields + sets updatedAt", () => {
  const cur = { id: "r1", stage: "submitted", comment: "", updatedAt: "2026-06-16T00:00:00.000Z" };
  const m = mergePatch(cur, { stage: "queued", comment: "rush" }, "2026-06-16T01:00:00.000Z");
  assert.equal(m.stage, "queued");
  assert.equal(m.comment, "rush");
  assert.equal(m.updatedAt, "2026-06-16T01:00:00.000Z");
  assert.equal(m.id, "r1");
});

test("isStale compares updatedAt", () => {
  assert.equal(isStale("2026-06-16T00:00:00.000Z", "2026-06-16T01:00:00.000Z"), true);
  assert.equal(isStale("2026-06-16T02:00:00.000Z", "2026-06-16T01:00:00.000Z"), false);
});

test("genId + genToken format", () => {
  assert.match(genId("req"), /^req_[a-z0-9]+_[a-z0-9]+$/i);
  assert.ok(genToken(24).length >= 24);
  assert.notEqual(genToken(), genToken());
});
