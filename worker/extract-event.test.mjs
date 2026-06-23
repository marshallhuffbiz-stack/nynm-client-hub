import { test } from "node:test";
import assert from "node:assert/strict";
import { buildExtractPrompt, parseExtraction, makeExtractor } from "./extract-event.mjs";

test("buildExtractPrompt includes today, the request text, and the JSON schema", () => {
  const p = buildExtractPrompt("AP Southern Kitchen Saturday", "2026-06-22");
  assert.match(p, /2026-06-22/);
  assert.match(p, /AP Southern Kitchen Saturday/);
  assert.match(p, /"hasDate"/);
});

test("parseExtraction: clean JSON → normalized object", () => {
  const r = parseExtraction('{"hasDate":true,"confident":true,"title":"AP Southern Kitchen","ymd":"2026-06-28","timeStart":"11 AM","timeEnd":"4 PM","kind":"vendor-day","vendor":"AP","description":"x"}');
  assert.equal(r.hasDate, true);
  assert.equal(r.confident, true);
  assert.equal(r.ymd, "2026-06-28");
  assert.equal(r.kind, "vendor-day");
  assert.equal(r.title, "AP Southern Kitchen");
});

test("parseExtraction: prose-wrapped JSON still parses", () => {
  const r = parseExtraction('Sure!\n{"hasDate":true,"confident":false,"ymd":"2026-07-04","title":"Cookout"}\nHope that helps.');
  assert.equal(r.hasDate, true);
  assert.equal(r.confident, false);
  assert.equal(r.ymd, "2026-07-04");
});

test("parseExtraction: junk / empty / API-error payload → transient error (not a real no-date)", () => {
  assert.deepEqual(parseExtraction("no json here"), { hasDate: false, confident: false, error: true });
  assert.deepEqual(parseExtraction(""), { hasDate: false, confident: false, error: true });
  // an API/auth error JSON lacks our boolean hasDate → flagged transient, NOT "no date"
  assert.equal(parseExtraction('{"type":"error","error":{"type":"authentication_error"}}').error, true);
  // a genuine "no date" reply is valid (error:false), distinct from a failure
  const real = parseExtraction('{"hasDate":false,"confident":false}');
  assert.equal(real.error, false);
  assert.equal(real.hasDate, false);
});

test("makeExtractor: wires prompt → runClaude → parse", async () => {
  let seen = "";
  const extract = makeExtractor({
    runClaude: async (p) => { seen = p; return '{"hasDate":true,"confident":true,"title":"X","ymd":"2026-06-28","kind":"event"}'; },
    today: () => "2026-06-22",
  });
  const r = await extract("X on Jun 28");
  assert.match(seen, /2026-06-22/);
  assert.equal(r.ymd, "2026-06-28");
  assert.equal(r.kind, "event");
});
