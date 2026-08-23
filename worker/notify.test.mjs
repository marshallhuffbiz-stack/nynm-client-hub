// ntfy push headers: every notification deep-links to the Desk, failures are urgent.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
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

// ---- static guard: no notifier method may be called that makeNotifier doesn't define ----
//
// site-apply.mjs reaches its notifier through OPTIONAL CHAINING (notifier.notifyError?.(…)),
// so a method that was never defined is not a crash, it is a silent no-op. That is exactly
// how every website-deploy failure went unreported. Reviewing for it clearly doesn't work,
// so scan the source instead: collect every notifier.<name> the worker references and prove
// each one is a real function on the object makeNotifier() hands back.

const WORKER_DIR = dirname(fileURLToPath(import.meta.url));
// Generated scratch / unit files, not worker source: the drain writes .mjs into out/, so
// scanning it would make this test depend on whatever a past drain run happened to leave.
const SKIP_DIRS = new Set(["node_modules", "out", "logs", "systemd"]);

function workerSources(dir = WORKER_DIR, acc = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) workerSources(join(dir, ent.name), acc);
    } else if (ent.name.endsWith(".mjs")) {
      acc.push(join(dir, ent.name));
    }
  }
  return acc;
}

// Blank the CONTENTS of comments and string/template literals (delimiters and newlines stay,
// so nothing new becomes adjacent), leaving only real code for the scan. An import specifier
// like "./notify.mjs" must not read as a method reference.
//
// This is a single pass rather than a chain of .replace()s on purpose: chained regexes get
// this wrong both ways round. Strip comments first and the "//" inside "https://ntfy.sh/t"
// eats the rest of that line, unbalancing every quote after it; strip strings first and an
// apostrophe inside a prose comment does the same thing.
function stripNonCode(src) {
  const out = src.split("");
  const blank = (i) => { if (out[i] !== "\n") out[i] = " "; };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") blank(i++);
    } else if (ch === "/" && next === "*") {
      blank(i++);
      blank(i++);
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) blank(i++);
      blank(i++);
      blank(i++);
    } else if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i += 1; // keep the opening delimiter
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") blank(i++); // an escape consumes the char after it
        if (i < src.length) blank(i++);
      }
      i += 1; // keep the closing delimiter
    } else {
      i += 1;
    }
  }
  return out.join("");
}

// Matches a call (notifier.notifyX(…), notifier.notifyX?.(…)) and a bare capability guard
// (notifier && notifier.notifyX) alike. Both are promises that the method exists.
const NOTIFIER_REF = /\bnotif(?:ier|y)\s*\??\.\s*([A-Za-z_$][\w$]*)/g;

test("every notifier.<method> the worker calls is defined on makeNotifier() (optional chaining can't hide a typo)", async () => {
  const { makeNotifier } = await import("./notify.mjs");
  const n = makeNotifier({ push: { mode: "off" } });

  const refs = new Map(); // method name -> the first file that references it
  for (const file of workerSources()) {
    const code = stripNonCode(readFileSync(file, "utf8"));
    for (const m of code.matchAll(NOTIFIER_REF)) {
      if (!refs.has(m[1])) refs.set(m[1], basename(file));
    }
  }

  // Guard the guard: if the scan silently stops finding anything, the test would pass forever.
  assert.ok(refs.size > 0, "scanner found no notifier.<method> references at all; the scan itself is broken");

  const missing = [...refs].filter(([name]) => typeof n[name] !== "function");
  assert.deepEqual(
    missing.map(([name]) => name),
    [],
    "makeNotifier() never defines: " + missing.map(([name, file]) => name + " (called in " + file + ")").join(", ")
  );

  // The two that site-apply.mjs was swallowing before 2026-08-23. Pin them explicitly so a
  // future refactor of the scanner can't quietly stop covering the case that caused the bug.
  assert.ok(refs.has("notifyError"), "site-apply.mjs should still be calling notifyError");
  assert.ok(refs.has("notifyDeployed"), "site-apply.mjs should still be calling notifyDeployed");
});

test("notifyDeployed reports the live URL; notifyError pushes at urgent priority", async () => {
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true }; };
  try {
    const { makeNotifier } = await import("./notify.mjs");
    const n = makeNotifier({ push: { mode: "ntfy", url: "https://ntfy.sh/t" } });

    await n.notifyDeployed({ clientId: "the-o", title: "Hours fix", url: "https://theo.example/" });
    assert.equal(calls[0].opts.headers.Priority, undefined); // normal priority
    assert.match(String(calls[0].opts.body), /the-o: "Hours fix" is live at https:\/\/theo\.example\//);

    await n.notifyError({ clientId: "the-o", title: "Hours fix", reason: "git push failed: denied" });
    assert.equal(calls[1].opts.headers.Priority, "high"); // urgent
    assert.equal(calls[1].opts.headers.Tags, "warning");
    assert.match(String(calls[1].opts.body), /git push failed: denied/);
  } finally { globalThis.fetch = origFetch; }
});
