import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureHostCredit, loadHostRule, EATS_INTEGRATIONS } from "./host-credit.mjs";
import { postsCreateArgs } from "./publish.mjs";

const FB = "cmpbcoidl0007p16a401xgy4a";
const IG = "cmph1srif002fp16a180murqx";
const OTHER = "someOtherBrandIntegration";

// Fixed rule so the tests do not depend on brand.json being present or current.
const RULE = {
  hostName: "Driven Creations Custom",
  label: "Hosted by",
  creditLine: "Hosted by Driven Creations Custom.",
  creditLineInstagram: "Hosted by Driven Creations Custom (@drivencreationscustom)",
  igHandle: "@drivencreationscustom",
};

// --- scope ---

test("passes non-Eats integrations through untouched", () => {
  const r = ensureHostCredit("Some other brand's post.", OTHER, RULE);
  assert.equal(r.changed, false);
  assert.equal(r.action, "not-eats");
  assert.equal(r.caption, "Some other brand's post.");
});

test("knows both Eats channels and their platforms", () => {
  assert.equal(EATS_INTEGRATIONS[FB], "facebook");
  assert.equal(EATS_INTEGRATIONS[IG], "instagram");
});

// --- the actual regression: the bare captions that shipped 2026-08-21 ---

test("REGRESSION: the Blue Plate daily drop that shipped bare on FB gets the credit", () => {
  const bare =
    "On the lot today: Blue Plate Food Truck, 11 AM to 4 PM. Pull off Hwy 601 in Mocksville, " +
    "grab a plate, and pull up a lawn chair. Come see us. " +
    "#EatsOn601 #Mocksville #FoodTrucks #DavieCounty";
  const r = ensureHostCredit(bare, FB, RULE);
  assert.equal(r.changed, true);
  assert.equal(r.action, "added");
  assert.match(r.caption, /Hosted by Driven Creations Custom\./);
  // Credit sits on its own line BEFORE the hashtag block.
  const lines = r.caption.split("\n").filter((l) => l.trim());
  const creditAt = lines.findIndex((l) => l.includes("Hosted by"));
  const tagsAt = lines.findIndex((l) => l.trim().startsWith("#"));
  assert.ok(creditAt > -1 && tagsAt > -1, "both credit and hashtags present");
  assert.ok(creditAt < tagsAt, "credit must come before the hashtags");
  // Facebook must not carry an "@" handle.
  assert.ok(!r.caption.includes("@drivencreationscustom"));
});

test("REGRESSION: same caption on IG gets the tappable handle form", () => {
  const bare = "On the lot today: Blue Plate Food Truck, 11 AM to 4 PM.\n\n#EatsOn601";
  const r = ensureHostCredit(bare, IG, RULE);
  assert.equal(r.action, "added");
  assert.match(r.caption, /Hosted by Driven Creations Custom \(@drivencreationscustom\)/);
});

// --- idempotence: never double-credit ---

test("a caption that already has the credit is left alone", () => {
  const good = "Two trucks on the lot today.\n\nHosted by Driven Creations Custom.";
  const r = ensureHostCredit(good, FB, RULE);
  assert.equal(r.changed, false);
  assert.equal(r.action, "ok");
  assert.equal(r.caption, good);
});

test("running twice adds exactly one credit", () => {
  const once = ensureHostCredit("Bare caption.", FB, RULE).caption;
  const twice = ensureHostCredit(once, FB, RULE).caption;
  assert.equal(twice, once);
  assert.equal(twice.match(/Hosted by/g).length, 1);
});

// --- label drift: the 'Sponsored by' class of error ---

test("corrects 'Sponsored by' to the exact words the client asked for", () => {
  const r = ensureHostCredit("Bike Night.\n\nSponsored by Driven Creations Custom.", FB, RULE);
  assert.equal(r.action, "relabelled");
  assert.match(r.caption, /Hosted by Driven Creations Custom\./);
  assert.ok(!/Sponsored by/i.test(r.caption));
  assert.equal(r.caption.match(/Driven Creations Custom/g).length, 1, "no duplicate credit appended");
});

test("corrects the older 'Hosted on the lot by' drift without duplicating", () => {
  const r = ensureHostCredit("Truck Night.\n\nHosted on the lot by Driven Creations Custom.", IG, RULE);
  assert.ok(!/on the lot by/i.test(r.caption));
  assert.equal(r.caption.match(/Driven Creations Custom/g).length, 1);
});

// --- Facebook must never carry a dead literal @tag ---

test("strips the IG handle from a Facebook caption", () => {
  const r = ensureHostCredit("On the lot.\n\nHosted by Driven Creations Custom (@drivencreationscustom)", FB, RULE);
  assert.ok(!r.caption.includes("@drivencreationscustom"));
  assert.match(r.caption, /Hosted by Driven Creations Custom/);
  assert.equal(r.changed, true);
});

test("keeps the IG handle on an Instagram caption", () => {
  const good = "On the lot.\n\nHosted by Driven Creations Custom (@drivencreationscustom)";
  const r = ensureHostCredit(good, IG, RULE);
  assert.equal(r.changed, false);
  assert.ok(r.caption.includes("@drivencreationscustom"));
});

// --- edge cases that must not throw ---

test("handles an empty caption", () => {
  const r = ensureHostCredit("", FB, RULE);
  assert.equal(r.caption.trim(), "Hosted by Driven Creations Custom.");
});

test("handles a hashtags-only caption", () => {
  const r = ensureHostCredit("#EatsOn601 #Mocksville", IG, RULE);
  const lines = r.caption.split("\n").filter((l) => l.trim());
  assert.ok(lines[0].includes("Hosted by"), "credit goes above a hashtag-only caption");
  assert.ok(lines[lines.length - 1].startsWith("#"));
});

test("handles null/undefined without throwing", () => {
  assert.doesNotThrow(() => ensureHostCredit(null, FB, RULE));
  assert.doesNotThrow(() => ensureHostCredit(undefined, IG, RULE));
});

test("loadHostRule falls back rather than throwing on a missing brand file", () => {
  const rule = loadHostRule("/nope/does/not/exist.json");
  assert.equal(rule.hostName, "Driven Creations Custom");
  assert.equal(rule.label, "Hosted by");
});

// --- the chokepoint itself ---

test("postsCreateArgs enforces the credit in the argv it builds", () => {
  const args = postsCreateArgs({ caption: "Bare.", isoTime: "2026-08-22T13:30:00Z", integrationId: FB });
  const caption = args[args.indexOf("-c") + 1];
  assert.match(caption, /Hosted by Driven Creations Custom\./);
});

test("postsCreateArgs reports the repair so it is never silent", () => {
  const seen = [];
  postsCreateArgs({
    caption: "Bare.",
    isoTime: "2026-08-22T13:30:00Z",
    integrationId: IG,
    onRepair: (info) => seen.push(info),
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].action, "added");
  assert.equal(seen[0].platform, "instagram");
});

test("postsCreateArgs does not fire onRepair for an already-correct caption", () => {
  const seen = [];
  postsCreateArgs({
    caption: "On the lot.\n\nHosted by Driven Creations Custom.",
    isoTime: "2026-08-22T13:30:00Z",
    integrationId: FB,
    onRepair: (info) => seen.push(info),
  });
  assert.equal(seen.length, 0);
});

test("postsCreateArgs leaves other brands' captions alone", () => {
  const args = postsCreateArgs({ caption: "The O tonight.", isoTime: "2026-08-22T13:30:00Z", integrationId: OTHER });
  assert.equal(args[args.indexOf("-c") + 1], "The O tonight.");
});

test("postsCreateArgs still appends -m LAST so the CLI never reads it as the caption", () => {
  const args = postsCreateArgs({ caption: "x", isoTime: "t", integrationId: FB, mediaUrl: "https://img" });
  assert.equal(args[args.length - 2], "-m");
  assert.equal(args[args.length - 1], "https://img");
  assert.notEqual(args[args.indexOf("-c") + 1], "-m");
});

test("a failing onRepair logger never blocks the post", () => {
  assert.doesNotThrow(() =>
    postsCreateArgs({
      caption: "Bare.",
      isoTime: "t",
      integrationId: FB,
      onRepair: () => {
        throw new Error("logger exploded");
      },
    })
  );
});
