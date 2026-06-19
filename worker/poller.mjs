// Client Hub worker — the launchd entry point. Every tick it:
//   1. pulls the live request list (admin token),
//   2. notifies Marshall of brand-new requests (push + Mac),
//   3. runs the Claude drain for queued/changes (stage a draft) and approved (ship),
//   4. sends a daily digest when due.
// runOnce() is dependency-injected so it can be tested without spawning Claude.
import { readFile, writeFile, mkdir, statfs } from "node:fs/promises";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { detectJobs, shouldRunDigest } from "./jobs.mjs";
import { digestSummary } from "../core/model.mjs";
import { apiFetchAll, apiUpdate } from "./writeback.mjs";
import { makeNotifier } from "./notify.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export async function runOnce({
  apiBase,
  adminToken,
  caps = { draft: 5, ship: 5 },
  drainer,
  notifier,
  digestHour = 8,
  getLastDigest,
  setLastDigest,
  now = new Date(),
}) {
  const all = await apiFetchAll(apiBase, adminToken);
  if (!all.ok) throw new Error("fetch all failed: " + (all.error || all.status));
  const reqs = all.requests || [];
  const jobs = detectJobs(reqs, caps);

  for (const r of jobs.newSubmits) {
    await notifier.notifyNew(r);
    await apiUpdate(apiBase, adminToken, r.id, { meta: { ...(r.meta || {}), notified: true } });
  }

  let drainResult = { drafted: 0, shipped: 0 };
  if (jobs.drafts.length || jobs.ships.length) {
    drainResult = (await drainer({ apiBase, adminToken, drafts: jobs.drafts, ships: jobs.ships })) || drainResult;
  }

  let digest = false;
  if (getLastDigest && shouldRunDigest(await getLastDigest(), now, digestHour)) {
    await notifier.notifyDigest(digestSummary(reqs));
    if (setLastDigest) await setLastDigest(now.toISOString());
    digest = true;
  }

  return { newSubmits: jobs.newSubmits.length, drafts: jobs.drafts.length, ships: jobs.ships.length, digest, ...drainResult };
}

// Real drainer: write the job brief, spawn one headless Claude that processes it
// per worker/drain.md (Claude writes results back via worker/wb.mjs). Caller waits.
export function spawnClaudeDrain({ claudeBin = "claude", cwd = join(HERE, "..") }) {
  return async ({ drafts, ships }) => {
    const briefPath = join(HERE, "drain-jobs.json");
    await writeFile(briefPath, JSON.stringify({ drafts, ships, at: new Date().toISOString() }, null, 2));
    const drainPrompt = await readFile(join(HERE, "drain.md"), "utf8");
    await new Promise((resolve) => {
      const child = spawn(claudeBin, ["-p", drainPrompt, "--settings", join(HERE, "claude-settings.json")], {
        cwd,
        stdio: ["ignore", "inherit", "inherit"],
      });
      child.on("close", () => resolve());
      child.on("error", () => resolve());
    });
    // The drain itself moves rows to ready/done; we report what we handed off.
    return { drafted: drafts.length, shipped: ships.length };
  };
}

// Pre-flight disk guard. Rendering a post needs room; if the machine is low on
// disk the render fails and silently strands a request in "drafting" (and the
// worker can't even write its .lock). So BEFORE drafting we check free space: if
// it's below the floor, surface every blocked request as a clear "out of space"
// error (the Desk shows it with a Retry), notify Marshall, and tell the caller to
// skip this tick. All writebacks are network calls, so they work with a full disk.
// statfsFn/fetchAll/update/notifier are injected so this is unit-testable.
export async function preflightDisk({
  apiBase,
  adminToken,
  minFreeBytes,
  dir,
  statfsFn = statfs,
  fetchAll = apiFetchAll,
  update = apiUpdate,
  notifier,
}) {
  let free;
  try {
    const st = await statfsFn(dir);
    free = st.bavail * st.bsize;
  } catch {
    return { ok: true, free: null }; // can't measure -> don't block
  }
  if (free >= minFreeBytes) return { ok: true, free };

  const freeMB = Math.round(free / 1048576);
  let marked = 0;
  try {
    const all = await fetchAll(apiBase, adminToken);
    const blocked = ((all && all.requests) || []).filter((r) => r.stage === "queued" || r.stage === "drafting");
    const msg = `Out of space on the worker machine (${freeMB} MB free). Free disk space, then tap Retry.`;
    for (const r of blocked) {
      const meta = { ...(r.meta || {}), run: { ...((r.meta && r.meta.run) || {}), error: msg } };
      const res = await update(apiBase, adminToken, r.id, { stage: "error", meta });
      if (res && res.ok !== false) marked += 1;
    }
    if (notifier && notifier.notifyBlocked) await notifier.notifyBlocked({ freeMB, count: blocked.length });
  } catch {
    /* surfacing is best-effort; the important part is NOT attempting the render */
  }
  return { ok: false, free, marked };
}

// True if `pid` is a currently-running process — used to tell a live drain's lock
// from a stale one left by a crashed, killed, or out-of-space run. EPERM means the
// process exists but is owned by another user, which still counts as alive.
export function isLiveProcess(pid) {
  const n = Number(pid);
  if (!n || Number.isNaN(n)) return false;
  try { process.kill(n, 0); return true; } catch (e) { return !!(e && e.code === "EPERM"); }
}

async function loadConfig() {
  const p = join(HERE, "config.json");
  if (!existsSync(p)) throw new Error("worker/config.json missing — copy config.example.json and fill it in (SETUP.md §4)");
  return JSON.parse(await readFile(p, "utf8"));
}

async function stateGetSet() {
  const p = join(HERE, ".state.json");
  const read = async () => (existsSync(p) ? JSON.parse(await readFile(p, "utf8")) : {});
  return {
    getLastDigest: async () => (await read()).lastDigest || null,
    setLastDigest: async (iso) => {
      const s = await read();
      s.lastDigest = iso;
      await writeFile(p, JSON.stringify(s, null, 2));
    },
  };
}

// CLI entry (launchd runs this). pathToFileURL handles paths with spaces/encoding.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const lock = join(HERE, ".lock");
  try {
    const cfg = await loadConfig();
    // Pre-flight: if the disk is too low to render, surface it + skip (don't strand a request mid-render).
    const guard = await preflightDisk({
      apiBase: cfg.execUrl,
      adminToken: cfg.adminToken,
      minFreeBytes: cfg.minFreeBytes ?? 2 * 1024 ** 3,
      dir: HERE,
      notifier: makeNotifier(cfg),
    });
    if (!guard.ok) {
      console.error(new Date().toISOString(), `worker paused: low disk (${Math.round((guard.free || 0) / 1048576)} MB free); flagged ${guard.marked} request(s) for retry`);
      process.exit(0);
    }
    if (existsSync(lock)) {
      let heldPid = "";
      try { heldPid = readFileSync(lock, "utf8").trim(); } catch {}
      if (isLiveProcess(heldPid)) {
        console.log("another drain holds the lock; skipping this tick");
        process.exit(0);
      }
      // Stale lock (a crashed / killed / out-of-space run, or an empty file) — reclaim it.
      console.error(new Date().toISOString(), `reclaiming stale lock (pid ${heldPid || "none"} not running)`);
      try { unlinkSync(lock); } catch {}
    }
    await mkdir(HERE, { recursive: true });
    await writeFile(lock, String(process.pid));
    const { getLastDigest, setLastDigest } = await stateGetSet();
    const res = await runOnce({
      apiBase: cfg.execUrl,
      adminToken: cfg.adminToken,
      caps: cfg.caps || { draft: 5, ship: 5 },
      drainer: spawnClaudeDrain({ claudeBin: cfg.claudeBin || "claude" }),
      notifier: makeNotifier(cfg),
      digestHour: cfg.digestHour ?? 8,
      getLastDigest,
      setLastDigest,
    });
    console.log(new Date().toISOString(), "drain:", JSON.stringify(res));
  } catch (e) {
    console.error("poller error:", e.message);
  } finally {
    try { unlinkSync(lock); } catch {}
  }
}
