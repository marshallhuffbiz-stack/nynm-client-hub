import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLaunchManifest, installLaunchManifest } from "./pwa.js";

const BASE = {
  name: "Relay by Not Your Normal Marketing",
  short_name: "Relay",
  display: "standalone",
  icons: [{ src: "../shared/relay-icon-192.png", sizes: "192x192", type: "image/png" }],
};

const HREF = "https://x.github.io/nynm-client-hub/portal/?c=abc123";
const MANIFEST_HREF = "https://x.github.io/nynm-client-hub/portal/manifest.webmanifest";

test("buildLaunchManifest: start_url carries the token, scope is the directory", () => {
  const m = buildLaunchManifest(BASE, { href: HREF, manifestHref: MANIFEST_HREF, param: "c", token: "abc123" });
  assert.equal(m.start_url, "https://x.github.io/nynm-client-hub/portal/?c=abc123");
  assert.equal(m.scope, "https://x.github.io/nynm-client-hub/portal/");
  assert.equal(m.display, "standalone");
  assert.equal(m.name, BASE.name);
});

test("buildLaunchManifest: resolves relative icon srcs to absolute (data: manifest has no base)", () => {
  const m = buildLaunchManifest(BASE, { href: HREF, manifestHref: MANIFEST_HREF, param: "c", token: "abc123" });
  assert.equal(m.icons[0].src, "https://x.github.io/nynm-client-hub/shared/relay-icon-192.png");
  assert.equal(m.icons[0].sizes, "192x192");
});

// A throwaway DOM stub: just enough surface for installLaunchManifest.
function fakeDoc(existingLink = null) {
  const created = [];
  const head = { appended: [], appendChild(node) { this.appended.push(node); } };
  return {
    _created: created,
    head,
    querySelector(sel) { return sel === 'link[rel="manifest"]' ? existingLink : null; },
    createElement(tag) {
      const node = { tag, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
      created.push(node);
      return node;
    },
  };
}

test("installLaunchManifest: creates a manifest link with a data: URL containing the token", () => {
  const doc = fakeDoc(null);
  const href = installLaunchManifest({ doc, base: BASE, href: HREF, manifestHref: MANIFEST_HREF, param: "c", token: "abc123" });
  assert.match(href, /^data:application\/manifest\+json/);
  const json = decodeURIComponent(href.split(",")[1]);
  const m = JSON.parse(json);
  assert.equal(m.start_url, "https://x.github.io/nynm-client-hub/portal/?c=abc123");
  // a fresh <link rel="manifest"> was created and attached to <head>
  assert.equal(doc._created.length, 1);
  assert.equal(doc._created[0].attrs.rel, "manifest");
  assert.equal(doc.head.appended.length, 1);
});

test("installLaunchManifest: reuses an existing manifest link instead of adding another", () => {
  const existing = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  const doc = fakeDoc(existing);
  installLaunchManifest({ doc, base: BASE, href: HREF, manifestHref: MANIFEST_HREF, param: "c", token: "abc123" });
  assert.equal(doc._created.length, 0, "should not create a second manifest link");
  assert.match(existing.attrs.href, /^data:application\/manifest\+json/);
});

test("installLaunchManifest: no-ops without a token", () => {
  const doc = fakeDoc(null);
  const out = installLaunchManifest({ doc, base: BASE, href: HREF, manifestHref: MANIFEST_HREF, param: "c", token: "" });
  assert.equal(out, null);
  assert.equal(doc._created.length, 0);
});
