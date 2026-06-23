// worker/site-sync.mjs — publish an event onto the Eats on 601 website by writing it
// into src/content/events.json and pushing to main (Cloudflare Pages auto-deploys on
// push, gated by the repo's CI tests + build). Runs in the poller (plain Node), NOT the
// sandboxed drain, so git is allowed.
//
// Guarded so it can NEVER clobber Marshall's working copy: it only acts when the site
// repo is on `main` and events.json has no uncommitted local changes, commits ONLY
// events.json, and bails (skips + reports) on any git failure or conflict.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { mergeSiteEvents } from "./events-auto.mjs";

const EVENTS_REL = "src/content/events.json";

function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: (stdout || "").toString().trim(), err: (stderr || "").toString().trim() });
    });
  });
}

// Real git adapter bound to a working dir. Injected as `git` into syncSiteEvent so the
// orchestration is unit-tested without touching a real repo.
export function makeGit(cwd) {
  return {
    branch: () => run("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd),
    status: () => run("git", ["status", "--porcelain", "--", EVENTS_REL], cwd),
    pull: () => run("git", ["pull", "--rebase", "--autostash", "origin", "main"], cwd),
    add: () => run("git", ["add", EVENTS_REL], cwd),
    commit: (m) => run("git", ["commit", "-m", m], cwd),
    push: () => run("git", ["push", "origin", "main"], cwd),
  };
}

export function makeEventsIO(siteDir) {
  const path = join(siteDir, EVENTS_REL);
  return {
    read: async () => JSON.parse(await readFile(path, "utf8")),
    write: async (arr) => writeFile(path, JSON.stringify(arr, null, 2) + "\n"),
  };
}

// Upsert `entry` into events.json and push. Returns:
//   { ok:true, changed:true }            — committed + pushed
//   { ok:true, changed:false }           — already present (idempotent no-op)
//   { ok:false, skipped:true, reason }   — guard tripped (dirty/off-main/pull failed)
//   { ok:false, reason }                 — a git step failed
export async function syncSiteEvent({ entry, git, io }) {
  const branch = await git.branch();
  if (!branch.ok || branch.out !== "main") {
    return { ok: false, skipped: true, reason: `site repo not on main (on "${branch.out || branch.err}")` };
  }
  const status = await git.status();
  if (status.ok && status.out) {
    return { ok: false, skipped: true, reason: "events.json has uncommitted local changes — not touching it" };
  }
  const pull = await git.pull();
  if (!pull.ok) return { ok: false, skipped: true, reason: "git pull failed: " + (pull.err || pull.out) };

  const existing = await io.read();
  const merged = mergeSiteEvents(existing, entry);
  if (JSON.stringify(existing) === JSON.stringify(merged)) {
    return { ok: true, changed: false, reason: "already on the site" };
  }
  await io.write(merged);

  const add = await git.add();
  if (!add.ok) return { ok: false, reason: "git add failed: " + (add.err || add.out) };
  const commit = await git.commit(`events: ${entry.title} — ${entry.date} [auto]`);
  if (!commit.ok) return { ok: false, reason: "git commit failed: " + (commit.err || commit.out) };
  const push = await git.push();
  if (!push.ok) return { ok: false, reason: "git push failed: " + (push.err || push.out) };
  return { ok: true, changed: true };
}
