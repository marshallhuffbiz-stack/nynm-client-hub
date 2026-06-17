// Client Hub worker — the launchd entry point. Every tick it:
//   1. pulls the live request list (admin token),
//   2. notifies Marshall of brand-new requests (push + Mac),
//   3. runs the Claude drain for queued/changes (stage a draft) and approved (ship),
//   4. sends a daily digest when due.
// runOnce() is dependency-injected so it can be tested without spawning Claude.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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

// CLI entry (launchd runs this).
if (import.meta.url === `file://${process.argv[1]}`) {
  const lock = join(HERE, ".lock");
  try {
    if (existsSync(lock)) {
      console.log("another drain holds the lock; skipping this tick");
      process.exit(0);
    }
    await mkdir(HERE, { recursive: true });
    await writeFile(lock, String(process.pid));
    const cfg = await loadConfig();
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
    try {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(lock);
    } catch {}
  }
}
