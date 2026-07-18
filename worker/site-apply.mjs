// worker/site-apply.mjs — deterministically apply an APPROVED `website` change onto a
// client's live site and prove it deployed before calling it done.
//
// Runs in the poller (plain Node, git allowed), NOT the sandboxed drain — same trust
// boundary as site-sync.mjs. The drain (draft stage) writes the corrected files to
// worker/out/<id>/scratch/<repo-rel-path> plus a manifest:
//   { files:[...repo-rel...], commitMessage, verify:{ absentOnLive:[...], presentOnLive:[...] } }
// On approval this module: guards the repo, copies the corrected files in, commits ONLY
// those files, pushes main (Cloudflare Pages deploys), then POLLS THE LIVE URL until the
// verify assertions hold. It reports `verified:true` only when the change is actually on
// the live page — so the caller can mark the request done ONLY when done means live.
//
// Guarded like syncSiteEvent so it can never clobber Marshall's working copy: acts only
// on `main` with the target files clean, `git add`s only the manifest files (never -A),
// and bails on any git failure.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";

function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: (stdout || "").toString().trim(), err: (stderr || "").toString().trim() });
    });
  });
}

// Real git adapter bound to a site working dir. Injected as `git` into applySiteChange so
// the orchestration is unit-tested without touching a real repo. `status`/`add` take the
// explicit file list so we only ever inspect/stage the files the change actually touches.
export function makeRepoGit(cwd) {
  return {
    branch: () => run("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd),
    status: (files) => run("git", ["status", "--porcelain", "--", ...files], cwd),
    pull: () => run("git", ["pull", "--rebase", "--autostash", "origin", "main"], cwd),
    add: (files) => run("git", ["add", "--", ...files], cwd),
    commit: (m) => run("git", ["commit", "-m", m], cwd),
    push: () => run("git", ["push", "origin", "main"], cwd),
  };
}

// Copies the drain's corrected files (worker/out/<id>/scratch/<rel>) into the site repo,
// reporting whether the repo content actually changed (idempotency signal so a re-run
// doesn't create an empty commit).
export function makeFilesIO(siteDir, scratchDir) {
  return {
    apply: async (files) => {
      let changed = false;
      for (const rel of files) {
        const next = await readFile(join(scratchDir, rel), "utf8");
        let cur = null;
        try { cur = await readFile(join(siteDir, rel), "utf8"); } catch { /* new file */ }
        if (cur !== next) {
          await mkdir(dirname(join(siteDir, rel)), { recursive: true });
          await writeFile(join(siteDir, rel), next);
          changed = true;
        }
      }
      return { changed };
    },
  };
}

// Live verifier bound to a client's public URL. check() runs the poll loop below.
export function makeLive(url, opts = {}) {
  return {
    url,
    check: (verify = {}) =>
      verifyLive({ url, absentOnLive: verify.absentOnLive || [], presentOnLive: verify.presentOnLive || [], ...opts }),
  };
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll `url` until every `absentOnLive` string is gone from the served HTML and every
// `presentOnLive` string is there, or `attempts` run out. Cache-busts each request so a
// CDN edge cache can't mask a fresh deploy. fetchImpl/sleep are injected for tests.
export async function verifyLive({
  url,
  absentOnLive = [],
  presentOnLive = [],
  fetchImpl = fetch,
  attempts = 18,
  delayMs = 12000,
  sleep = defaultSleep,
  nonce = Date.now(),
}) {
  let lastReason = "never fetched";
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(delayMs);
    let html = "";
    try {
      const res = await fetchImpl(`${url}${url.includes("?") ? "&" : "?"}cb=${nonce}-${i}`);
      if (res && res.ok) html = await res.text();
      else { lastReason = `HTTP ${res && res.status ? res.status : "error"}`; continue; }
    } catch (e) {
      lastReason = "fetch error: " + (e && e.message ? e.message : String(e));
      continue;
    }
    const stillPresent = absentOnLive.filter((s) => html.includes(s));
    const missing = presentOnLive.filter((s) => !html.includes(s));
    if (stillPresent.length === 0 && missing.length === 0) return { ok: true, attempts: i + 1 };
    lastReason = [
      stillPresent.length ? `still shows: ${stillPresent.join(", ")}` : "",
      missing.length ? `missing: ${missing.join(", ")}` : "",
    ].filter(Boolean).join("; ");
  }
  return { ok: false, reason: lastReason, attempts };
}

// Apply + deploy + verify one approved website change. Return shape tells the caller how
// to set the request stage:
//   { ok:true,  changed, verified:true }              → mark DONE (confirmed live)
//   { ok:false, skipped:true, reason }                → guard tripped; leave approved, retry next tick
//   { ok:false, pushed:true, verified:false, reason } → pushed but not yet live; surface + notify
//   { ok:false, verified:false, reason }              → a git step failed; surface + notify
export async function applySiteChange({ manifest, git, io, live }) {
  const files = (manifest && manifest.files) || [];
  const verify = (manifest && manifest.verify) || { absentOnLive: [], presentOnLive: [] };

  const branch = await git.branch();
  if (!branch.ok || branch.out !== "main") {
    return { ok: false, skipped: true, verified: false, reason: `site repo not on main (on "${branch.out || branch.err}")` };
  }
  const status = await git.status(files);
  if (status.ok && status.out) {
    return { ok: false, skipped: true, verified: false, reason: "target files have uncommitted local changes — not touching them" };
  }
  const pull = await git.pull();
  if (!pull.ok) return { ok: false, skipped: true, verified: false, reason: "git pull failed: " + (pull.err || pull.out) };

  const applied = await io.apply(files);

  // Already committed on a prior tick (or a genuine no-op): don't re-commit; just confirm
  // it's actually live now. This self-heals a deploy that was still building last tick.
  if (!applied.changed) {
    const v = await live.check(verify);
    return v.ok
      ? { ok: true, changed: false, verified: true }
      : { ok: false, changed: false, pushed: false, verified: false, reason: "already committed but not confirmed live: " + v.reason };
  }

  const add = await git.add(files);
  if (!add.ok) return { ok: false, verified: false, reason: "git add failed: " + (add.err || add.out) };
  const commit = await git.commit(manifest.commitMessage);
  if (!commit.ok) return { ok: false, verified: false, reason: "git commit failed: " + (commit.err || commit.out) };
  const push = await git.push();
  if (!push.ok) return { ok: false, verified: false, reason: "git push failed: " + (push.err || push.out) };

  const v = await live.check(verify);
  if (v.ok) return { ok: true, changed: true, verified: true };
  return { ok: false, changed: true, pushed: true, verified: false, reason: "pushed but not confirmed live: " + v.reason };
}

// Error writeback that merges (never clobbers) the row's existing meta — a bare
// meta:{run} would wipe the client thread / activity / notified fields.
function errorPatch(r, reason) {
  const meta = (r && r.meta) || {};
  return {
    stage: "error",
    meta: { ...meta, run: { ...(meta.run || {}), status: "error", error: String(reason || "deploy failed") } },
    _note: `deploy failed: ${reason}`,
  };
}

// The approved-website ship path (poller-side, deterministic), mirroring publish.mjs's
// makeShipper for social posts. For each approved website request it: preps the change
// (manifest + git/io/live for that client's site), moves it approved→shipping, runs
// applySiteChange, then writes the OUTCOME as stage:
//   verified live       → done   (done finally means live)
//   transient guard      → back to approved (retry next tick — dirty repo / off-main / pull race)
//   pushed-not-verified  → error + notify (surfaced, never a false done)
//   git/prep failure     → error + notify
// `prepare` and `apply` are injected so the decision logic is unit-tested without fs/git.
export function makeSiteShipper({ apiUpdate, notifier = {}, prepare, apply = applySiteChange }) {
  return async ({ apiBase, adminToken, ships = [] }) => {
    let deployed = 0, failed = 0, deferred = 0;
    for (const r of ships) {
      const prep = await prepare(r);
      if (prep.error) {
        await apiUpdate(apiBase, adminToken, r.id, errorPatch(r, prep.error));
        failed += 1;
        try { await notifier.notifyError?.({ clientId: r.clientId, title: r.title, reason: prep.error }); } catch { /* non-fatal */ }
        continue;
      }
      await apiUpdate(apiBase, adminToken, r.id, { action: "ship", _note: `deploying to ${prep.liveUrl}` });
      const res = await apply({ manifest: prep.manifest, git: prep.git, io: prep.io, live: prep.live });
      if (res.ok && res.verified) {
        // Record the outcome in meta.run (preserving existing meta — the backend
        // deep-merges, but carry it anyway like publish.mjs does) so the portal
        // can show the client a "live on the site" receipt with the real URL.
        const baseMeta = (r && r.meta) || {};
        await apiUpdate(apiBase, adminToken, r.id, {
          action: "done",
          _note: `deployed + verified live: ${prep.liveUrl}`,
          meta: { ...baseMeta, run: { ...(baseMeta.run || {}), status: "deployed", liveUrl: prep.liveUrl, finishedAt: new Date().toISOString(), error: "" } },
        });
        deployed += 1;
        try { await notifier.notifyDeployed?.({ clientId: r.clientId, title: r.title, url: prep.liveUrl }); } catch { /* non-fatal */ }
      } else if (res.skipped) {
        // Transient: leave it approved so the next tick retries once the repo is clean/on-main.
        await apiUpdate(apiBase, adminToken, r.id, { stage: "approved", _note: `deploy deferred (will retry): ${res.reason}` });
        deferred += 1;
      } else {
        await apiUpdate(apiBase, adminToken, r.id, errorPatch(r, res.reason));
        failed += 1;
        try { await notifier.notifyError?.({ clientId: r.clientId, title: r.title, reason: res.reason }); } catch { /* non-fatal */ }
      }
    }
    return { deployed, failed, deferred };
  };
}
