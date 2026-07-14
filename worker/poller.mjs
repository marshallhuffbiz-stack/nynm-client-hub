// Client Hub worker — the launchd entry point. Every tick it:
//   1. pulls the live request list (admin token),
//   2. notifies Marshall of brand-new requests (push + Mac),
//   3. runs the Claude drain for queued/changes (stage a draft) and approved (ship),
//   4. sends a daily digest when due.
// runOnce() is dependency-injected so it can be tested without spawning Claude.
import { readFile, writeFile, mkdir, statfs } from "node:fs/promises";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { detectJobs, shouldRunDigest, detectOrphans, planOrphanRecovery, enrichJobs } from "./jobs.mjs";
import { digestSummary } from "../core/model.mjs";
import { apiFetchAll, apiUpdate, apiSubmit } from "./writeback.mjs";
import { makeNotifier, macNotify, pushNotify } from "./notify.mjs";
import { makeShipper, makePostizClient } from "./publish.mjs";
import { makeAutoEvents } from "./auto-events.mjs";
import { makeExtractor, makeRunClaude } from "./extract-event.mjs";
import { syncSiteEvent, makeGit, makeEventsIO } from "./site-sync.mjs";
import { makeSiteShipper, makeRepoGit, makeFilesIO, makeLive } from "./site-apply.mjs";
import { buildSchedule, reconcile as reconcileSchedule, makeScheduleIO } from "./schedule-sync.mjs";
import { runDailyPost } from "./daily-truck-post.mjs";
import { runMonthly } from "./monthly-truck-post.mjs";
import { runCancelPosts } from "./cancel-posts.mjs";
import { todayInET, etOffset } from "./events-auto.mjs";
import { onTickOutcome, repairCommand } from "./selfheal.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// Approved requests of these types auto-publish via the deterministic ship path
// (worker/publish.mjs). Everything else stays with the Claude drain.
const SOCIAL_SHIP_TYPES = new Set(["post", "event-promo"]);

export async function runOnce({
  apiBase,
  adminToken,
  caps = { draft: 5, ship: 5 },
  drainer,
  shipper,
  siteShipper,
  scheduleSync,
  truckPosts,
  autoEvents,
  notifier,
  digestHour = 8,
  getLastDigest,
  setLastDigest,
  orphanMaxAgeMs = 15 * 60 * 1000,
  maxRequeues = 3,
  now = new Date(),
}) {
  const all = await apiFetchAll(apiBase, adminToken);
  if (!all.ok) throw new Error("fetch all failed: " + (all.error || all.status));
  const reqs = all.requests || [];

  // Recover orphaned 'drafting' rows (a drain that died / ran out of space mid-render,
  // or a manual Retry that landed in 'drafting') by re-queueing them, and orphaned
  // 'shipping' rows (shipper died mid-publish / done-writeback lost) by re-approving
  // them into the ship lane WITH their approved draft. Capped per-row
  // (planOrphanRecovery) so a permanently-failing request surfaces a real error
  // instead of looping forever.
  let recovered = 0;
  for (const a of planOrphanRecovery(detectOrphans(reqs, now, orphanMaxAgeMs), maxRequeues)) {
    const res = await apiUpdate(apiBase, adminToken, a.id, a.patch);
    if (res && res.ok !== false && (a.patch.stage === "queued" || a.patch.stage === "approved")) recovered += 1;
  }

  const jobs = detectJobs(reqs, caps);

  // Eats on 601 date automation: dated requests -> website entry + a fully-auto day-of
  // post. Runs against the live backend; the auto-queued ids are skipped below so they
  // aren't also notified as brand-new.
  let autoRes = { queued: 0, skipped: 0, queuedIds: [] };
  let autoApproveRes = { approved: 0 };
  if (autoEvents) {
    autoRes = (await autoEvents.process({ apiBase, adminToken, requests: reqs })) || autoRes;
    autoApproveRes = (await autoEvents.autoApprove({ apiBase, adminToken, requests: reqs })) || autoApproveRes;
  }
  const autoQueued = new Set(autoRes.queuedIds || []);

  for (const r of jobs.newSubmits) {
    if (autoQueued.has(r.id)) continue; // auto-event already handled this tick
    await notifier.notifyNew(r);
    await apiUpdate(apiBase, adminToken, r.id, { meta: { ...(r.meta || {}), notified: true } });
  }

  // Social posts (post / event-promo) auto-publish via the deterministic shipper
  // in plain Node. Any other approved work (e.g. a website apply) stays with the
  // Claude drain, which never publishes to social (Skill(post) stays denied).
  // Only divert social posts to the shipper when one is injected; otherwise every
  // approved item goes to the drain (old behavior), so nothing is silently dropped.
  // Cap each lane independently (ships arrive uncapped from detectJobs) so a backlog
  // of website/other approved work can't starve social auto-publishing, and vice versa.
  // Website changes get their own deterministic lane (worker/site-apply.mjs): apply the
  // drain's staged files, push, and VERIFY the live URL before marking done — so "done"
  // can never again mean "committed locally but never deployed". Diverted out of the
  // drain lane exactly like social posts, and only when a siteShipper is injected (else
  // website work stays with the drain — old behavior, nothing silently dropped).
  const shipCap = (caps && caps.ship) || 5;
  const socialShips = (shipper ? jobs.ships.filter((r) => SOCIAL_SHIP_TYPES.has(r.type)) : []).slice(0, shipCap);
  const websiteShips = (siteShipper ? jobs.ships.filter((r) => r.type === "website") : []).slice(0, shipCap);
  const drainShips = (shipper ? jobs.ships.filter((r) => !SOCIAL_SHIP_TYPES.has(r.type)) : jobs.ships)
    .filter((r) => !(siteShipper && r.type === "website"))
    .slice(0, shipCap);

  // Drain jobs go out ENRICHED (client join: brandSlug/siteFolder/clientName; event
  // join: start/end times) — see enrichJobs. Raw rows have none of that, and drain.md
  // instructs a brand-less job to use a "neutral treatment".
  let drainResult = { drafted: 0, shipped: 0 };
  if (jobs.drafts.length || drainShips.length) {
    const clients = all.clients || [];
    const events = all.events || [];
    drainResult =
      (await drainer({
        apiBase,
        adminToken,
        drafts: enrichJobs(jobs.drafts, clients, events, reqs),
        ships: enrichJobs(drainShips, clients, events, reqs),
      })) || drainResult;
  }

  let shipResult = { shipped: 0, failed: 0 };
  if (socialShips.length && shipper) {
    shipResult = (await shipper({ apiBase, adminToken, ships: socialShips, clients: all.clients || [] })) || shipResult;
  }

  let siteResult = { deployed: 0, failed: 0, deferred: 0 };
  if (websiteShips.length && siteShipper) {
    siteResult =
      (await siteShipper({
        apiBase,
        adminToken,
        ships: enrichJobs(websiteShips, all.clients || [], all.events || [], reqs),
        clients: all.clients || [],
      })) || siteResult;
  }

  // Schedule-sync lane: auto-push the food-truck schedule to the Eats site when the
  // backend's bookings change. Reuses the SAME `all` payload fetched at the top of the
  // tick (no second fetch). Only runs when a scheduleSync runner is injected (dormant
  // otherwise, so nothing changes for clients without schedule enabled). The runner is
  // itself fail-soft, but belt-and-suspenders: guard the call too so a broken schedule
  // sync can NEVER break the drain/ship/site lanes.
  let scheduleResult = { deployed: 0, unchanged: 0, skipped: 0, failed: 0 };
  if (scheduleSync) {
    try {
      scheduleResult = (await scheduleSync({ all })) || scheduleResult;
    } catch (e) {
      console.error(new Date().toISOString(), "schedule-sync lane error (caught, tick continues):", e && e.message ? e.message : String(e));
    }
  }

  // Truck-post lane: submit+queue the day-of (and, on the draft day, the monthly) food-truck
  // post via the EXISTING drain→auto-approve→publish pipeline. Reuses the SAME `all` payload
  // (no second fetch). Dormant unless a site has schedule.enabled. Fail-soft belt-and-
  // suspenders (the runner is itself fail-soft per client): guard the call too so a broken
  // truck-post lane can NEVER break the drain/ship/site/schedule lanes.
  let truckResult = { dailyPostCreated: 0, dailyPostQueued: 0, dailyPostSkipped: 0, dailyPostFailed: 0, monthlyCreated: 0, monthlyQueued: 0, monthlySkipped: 0, monthlyFailed: 0, cancelQueued: 0, cancelFailed: 0 };
  if (truckPosts) {
    try {
      truckResult = (await truckPosts({ all, now })) || truckResult;
    } catch (e) {
      console.error(new Date().toISOString(), "truck-post lane error (caught, tick continues):", e && e.message ? e.message : String(e));
    }
  }

  let digest = false;
  if (getLastDigest && shouldRunDigest(await getLastDigest(), now, digestHour)) {
    await notifier.notifyDigest(digestSummary(reqs));
    if (setLastDigest) await setLastDigest(now.toISOString());
    digest = true;
  }

  return {
    newSubmits: jobs.newSubmits.length,
    drafts: jobs.drafts.length,
    ships: jobs.ships.length,
    digest,
    drafted: drainResult.drafted || 0,
    published: shipResult.shipped || 0,
    shipFailed: shipResult.failed || 0,
    deployed: siteResult.deployed || 0,
    deployFailed: siteResult.failed || 0,
    scheduleDeployed: scheduleResult.deployed || 0,
    scheduleSkipped: scheduleResult.skipped || 0,
    scheduleFailed: scheduleResult.failed || 0,
    dailyPostCreated: truckResult.dailyPostCreated || 0,
    dailyPostQueued: truckResult.dailyPostQueued || 0,
    dailyPostSkipped: truckResult.dailyPostSkipped || 0,
    dailyPostFailed: truckResult.dailyPostFailed || 0,
    monthlyCreated: truckResult.monthlyCreated || 0,
    monthlyQueued: truckResult.monthlyQueued || 0,
    monthlySkipped: truckResult.monthlySkipped || 0,
    monthlyFailed: truckResult.monthlyFailed || 0,
    cancelQueued: truckResult.cancelQueued || 0,
    cancelFailed: truckResult.cancelFailed || 0,
    autoQueued: autoRes.queued || 0,
    autoApproved: autoApproveRes.approved || 0,
    recovered,
  };
}

// Schedule-sync lane (poller-side, deterministic). For every client in cfg.sites whose
// `schedule.enabled` is true, build the food-truck schedule from the SAME `all` payload
// already fetched this tick (filtered to that client's bookings/vendors — no second
// fetch), and if it differs from the site repo's current schedule.json, push+verify it
// via schedule-sync's reconcile() (which reuses the real git/io/live built by `prepare`).
//
// SAFETY GUARD (empty-schedule): if the backend has no bookings yet so the built schedule
// is EMPTY, but the site's current schedule.json is NON-empty, we SKIP entirely and log —
// never overwriting the migrated bootstrap schedule with nothing. (This is enforced HERE,
// before reconcile, because reconcile's plain content-diff would happily deploy [] over a
// real schedule.)
//
// FAIL-SOFT: the whole lane is wrapped so ANY error (a throwing prepare, reconcile, git
// adapter, or fs read) is caught and logged per-client — it must NEVER throw out of the
// tick, or a broken schedule sync would take down the drain/ship/site lanes for The O and
// Eats. `prepare(clientId, site)` returns { git, io, live, config } and is injected so the
// decision logic is unit-tested without fs/git/network.
export async function runScheduleSync({ cfg = {}, all = {}, prepare, now = new Date(), log = console.error }) {
  const summary = { deployed: 0, unchanged: 0, skipped: 0, failed: 0 };
  const sites = (cfg && cfg.sites) || {};
  const bookings = all.bookings || [];
  const vendors = all.vendors || [];

  for (const clientId of Object.keys(sites)) {
    const site = sites[clientId];
    const sched = site && site.schedule;
    if (!sched || !sched.enabled) continue; // lane opt-in per client

    try {
      const clientBookings = bookings.filter((b) => b && b.clientId === clientId);
      const clientVendors = vendors.filter((v) => v && v.clientId === clientId);

      // Empty-schedule safety guard: never let an empty backend blow away a real
      // (non-empty) site schedule. Read the current file THROUGH the same io the
      // reconcile would use so tests and prod share one code path.
      const built = buildSchedule(clientBookings, clientVendors, { now });
      const prep = await prepare(clientId, site);
      const scheduleRel = (sched && sched.scheduleFile) || "src/content/schedule.json";
      if (built.length === 0) {
        let cur = null;
        try { cur = await prep.io.readFile(scheduleRel); } catch { cur = null; }
        const curTrimmed = (cur || "").trim();
        const curIsNonEmpty = curTrimmed && curTrimmed !== "[]";
        if (curIsNonEmpty) {
          summary.skipped += 1;
          log(new Date().toISOString(), `schedule-sync[${clientId}]: backend has no bookings but site schedule.json is non-empty — SKIP (bootstrap schedule preserved)`);
          continue;
        }
      }

      const res = await reconcileSchedule({
        fetchState: async () => ({ bookings: clientBookings, vendors: clientVendors }),
        git: prep.git,
        io: prep.io,
        live: prep.live,
        config: prep.config || sched,
        now,
      });

      if (res && res.ok && res.changed) summary.deployed += 1;
      else if (res && res.ok && res.changed === false) summary.unchanged += 1;
      else {
        summary.failed += 1;
        log(new Date().toISOString(), `schedule-sync[${clientId}]: not deployed — ${res && (res.reason || (res.skipped ? "guard skipped" : "unknown"))}`);
      }
    } catch (e) {
      summary.failed += 1;
      log(new Date().toISOString(), `schedule-sync[${clientId}]: FAILED (caught, tick continues) — ${e && e.message ? e.message : String(e)}`);
    }
  }
  return summary;
}

// The ET wall-clock "HH:MM" for an instant (used by the daily/monthly time-gates so a 90s
// VPS tick that lands after the configured post time fires the post, but no earlier).
export function etHhmm(now = new Date()) {
  const ymd = todayInET(now);
  const offH = Number(etOffset(ymd).slice(0, 3));
  const shifted = new Date(now.getTime() + offH * 3600 * 1000);
  return shifted.toISOString().slice(11, 16); // "HH:MM"
}

// True once the ET wall-clock time is at/after "HH:MM".
export function atOrAfterEt(now, hhmm) {
  return etHhmm(now) >= String(hhmm || "00:00");
}

// Truck-post lane (poller-side). For every schedule-enabled site, submit+queue the day-of
// and (on the draft day) the monthly post via the EXISTING drain→auto-approve→publish
// pipeline — runDailyPost / runMonthly do the idempotent create/queue keyed on a
// clientRequestId, so a re-run across the flaky VPS never double-posts.
//
// TIME-GATES: daily fires only once ET is at/after schedule.dailyPostTime (default "08:00").
// Monthly fires only on schedule.monthlyDraftDay (default the 25th), and also only at/after
// the daily time. Both are FAIL-SOFT per client (a throw is caught + logged, never breaks
// the tick or another client's post). The client's portal token is pulled from all.clients
// (submitRequest forces the tenant from it). If a site has no token, that client is skipped
// (logged) rather than throwing.
export async function runTruckPosts({ cfg = {}, all = {}, now = new Date(), log = console.error }) {
  const summary = { dailyPostCreated: 0, dailyPostQueued: 0, dailyPostSkipped: 0, dailyPostFailed: 0, monthlyCreated: 0, monthlyQueued: 0, monthlySkipped: 0, monthlyFailed: 0, cancelQueued: 0, cancelFailed: 0 };
  const sites = (cfg && cfg.sites) || {};
  const clients = all.clients || [];

  for (const clientId of Object.keys(sites)) {
    const site = sites[clientId];
    const sched = site && site.schedule;
    if (!sched || !sched.enabled) continue; // lane opt-in per client (dormant otherwise)

    const dailyTime = sched.dailyPostTime || "08:00";
    const draftDay = Number(sched.monthlyDraftDay ?? 25);

    const client = clients.find((c) => c && c.clientId === clientId);
    const clientToken = client && client.token;
    if (!clientToken) {
      log(new Date().toISOString(), `truck-post[${clientId}]: no portal token in all.clients — skipping (can't submit as the client)`);
      continue;
    }

    const submitRequest = (request, token) => apiSubmit(cfg.execUrl, token, request, request && request.clientRequestId);
    const updateRequest = (id, patch) => apiUpdate(cfg.execUrl, cfg.adminToken, id, patch);

    // Cancellation lane — NOT time-gated (a canceled truck should be announced on the
    // first tick after the client taps "they canceled" in the portal). runCancelPosts
    // is fail-soft per request; belt-and-suspenders here too.
    try {
      const cres = await runCancelPosts({ all, updateRequest, now, config: sched, clientId, log });
      summary.cancelQueued += (cres && cres.cancelQueued) || 0;
      summary.cancelFailed += (cres && cres.cancelFailed) || 0;
    } catch (e) {
      summary.cancelFailed += 1;
      log(new Date().toISOString(), `truck-post[${clientId}] cancel: FAILED (caught, tick continues) — ${e && e.message ? e.message : String(e)}`);
    }

    // Daily lane — gated on the ET time-of-day.
    if (atOrAfterEt(now, dailyTime)) {
      try {
        const res = await runDailyPost({ all, submitRequest, updateRequest, now, config: sched, clientId, clientToken });
        if (res && res.created) summary.dailyPostCreated += 1;
        else if (res && res.queued) summary.dailyPostQueued += 1;
        else if (res && res.skipped) summary.dailyPostSkipped += 1;
        // {created:false, reason:"no-trucks"} is a normal no-op — not surfaced as a failure.
      } catch (e) {
        summary.dailyPostFailed += 1;
        log(new Date().toISOString(), `truck-post[${clientId}] daily: FAILED (caught, tick continues) — ${e && e.message ? e.message : String(e)}`);
      }
    }

    // Monthly lane — only on the draft day, at/after the daily time.
    const dom = Number(todayInET(now).slice(8, 10));
    if (dom === draftDay && atOrAfterEt(now, dailyTime)) {
      try {
        const res = await runMonthly({ all, submitRequest, updateRequest, now, clientId, clientToken });
        if (res && res.created) summary.monthlyCreated += 1;
        else if (res && res.queued) summary.monthlyQueued += 1;
        else if (res && res.skipped) summary.monthlySkipped += 1;
      } catch (e) {
        summary.monthlyFailed += 1;
        log(new Date().toISOString(), `truck-post[${clientId}] monthly: FAILED (caught, tick continues) — ${e && e.message ? e.message : String(e)}`);
      }
    }
  }
  return summary;
}

// Real drainer: write the job brief, spawn one headless Claude that processes it
// per worker/drain.md (Claude writes results back via worker/wb.mjs). Caller waits.
// Build the headless `claude` argv for a drain run. Pure + exported so the model
// pin / settings path are unit-tested (a malformed flag array silently breaks the
// drain). `model` is optional: when set, drafts run on that model (e.g. Opus 4.8)
// instead of the CLI default; when unset, the flag is omitted.
export function drainArgs({ drainPrompt, settingsPath, model }) {
  const args = ["-p", drainPrompt, "--settings", settingsPath];
  if (model) args.push("--model", model);
  return args;
}

export function spawnClaudeDrain({
  claudeBin = "claude",
  cwd = join(HERE, ".."),
  model,
  oauthToken,
  timeoutMs = 10 * 60 * 1000,
  killGraceMs = 5000,
  spawnFn = spawn,
  briefPath = join(HERE, "drain-jobs.json"),
  promptPath = join(HERE, "drain.md"),
}) {
  return async ({ drafts, ships }) => {
    await writeFile(briefPath, JSON.stringify({ drafts, ships, at: new Date().toISOString() }, null, 2));
    const drainPrompt = await readFile(promptPath, "utf8");
    // Auth the headless drain with the Max-SUBSCRIPTION OAuth token (from
    // `claude setup-token`), NOT an API key — the macOS keychain that interactive
    // Claude Code uses isn't readable under launchd. Strip ANTHROPIC_API_KEY so the
    // subscription token always wins (an API key would take precedence and bill
    // per-token, which we explicitly do not want).
    const childEnv = { ...process.env };
    if (oauthToken) {
      childEnv.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
      delete childEnv.ANTHROPIC_API_KEY;
    }
    await new Promise((resolve) => {
      const child = spawnFn(claudeBin, drainArgs({ drainPrompt, settingsPath: join(HERE, "claude-settings.json"), model }), {
        cwd,
        env: childEnv,
        stdio: ["ignore", "inherit", "inherit"],
      });
      let settled = false;
      let timer = null;
      let killTimer = null;
      const settle = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        resolve();
      };
      // Hard wall-clock cap. A wedged drain (hung network / tool loop / MCP hang) must
      // NEVER hold the worker .lock forever — that would freeze EVERY client's pipeline
      // (drafts, auto-publish, notifications, digest) until a manual kill. SIGTERM, then
      // escalate to SIGKILL, then move on; the half-finished rows self-heal via the
      // drafting orphan-recovery on the next tick.
      timer = setTimeout(() => {
        console.error(new Date().toISOString(), `drain exceeded ${Math.round(timeoutMs / 1000)}s — terminating; affected rows re-queue via orphan recovery`);
        try { child.kill("SIGTERM"); } catch {}
        killTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} settle(); }, killGraceMs);
      }, timeoutMs);
      child.on("close", settle);
      child.on("error", settle);
    });
    // The drain itself moves rows to ready/done; we report what we handed off.
    return { drafted: drafts.length, shipped: ships.length };
  };
}

// Pre-flight disk guard. A render needs some scratch space; if the machine is truly
// out of space the render can fail and strand a request mid-draft. So BEFORE drafting
// we check free space against a SMALL floor (a few hundred MB — enough for one render
// plus the .lock write, NOT a conservative multi-GB cushion). If we're under it we
// DON'T touch the queue: rows stay exactly as they are and the worker auto-resumes once
// space frees. (The old guard flipped 'queued' -> 'error' at a 2 GB floor, which — with
// the Desk's Retry pushing 'error' -> 'drafting' — stranded requests in 'drafting' with
// no live drain. Non-destructive skip removes that whole trap.) statfsFn is injected so
// this is unit-testable.
export async function preflightDisk({ minFreeBytes, dir, statfsFn = statfs }) {
  let free;
  try {
    const st = await statfsFn(dir);
    free = st.bavail * st.bsize;
  } catch {
    return { ok: true, free: null }; // can't measure -> don't block
  }
  if (free >= minFreeBytes) return { ok: true, free };
  // Under the floor: skip this tick, leave every row untouched (non-destructive).
  return { ok: false, free, skipped: true };
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
// Track consecutive first-fetch failures across ticks (state survives because each
// launchd tick is a fresh process) and self-repair the macOS background-network
// wedge by relaunching our own job. See selfheal.mjs for the decision logic.
async function recordTickOutcome({ fetchOk }) {
  try {
    const stateFile = join(HERE, ".selfheal.json");
    let state = null;
    try { state = JSON.parse(readFileSync(stateFile, "utf8")); } catch {}
    const { next, repair } = onTickOutcome(state, { fetchOk, now: Date.now() });
    if (fetchOk && state && state.lastRepairAt && !state.recoveredNotified) {
      next.recoveredNotified = true;
      try {
        const cfg = JSON.parse(readFileSync(join(HERE, "config.json"), "utf8"));
        await pushNotify(cfg.push, "Relay worker recovered", "The worker lost network for a stretch, relaunched itself, and is draining the queue again. Anything submitted meanwhile is being picked up now.");
      } catch { /* best-effort */ }
    }
    if (repair) {
      if (process.platform === "darwin") {
        console.error(new Date().toISOString(), "self-heal: consecutive fetch failures hit the threshold; relaunching the worker job (macOS background-network wedge)");
        await macNotify("Relay worker self-healing", "Network calls failed for several minutes. Relaunching the worker job now.");
        const [bin, args] = repairCommand({
          uid: process.getuid(),
          plistPath: join(process.env.HOME || "/Users/MarshallHuff", "Library/LaunchAgents/com.nynm.client-worker.plist"),
        });
        const child = spawn(bin, args, { detached: true, stdio: "ignore" });
        child.unref();
      } else {
        // Linux/systemd: the launchctl wedge doesn't exist and the timer re-invokes a
        // fresh process every tick anyway — nothing to relaunch. Log so a real outage
        // (backend down, DNS broken) is visible in the journal, and let the failure
        // counter reset via the same state write below.
        console.error(new Date().toISOString(), "self-heal: consecutive fetch failures hit the threshold; no job relaunch needed under systemd — check network/backend if this persists");
      }
      delete next.recoveredNotified;
    }
    writeFileSync(stateFile, JSON.stringify(next));
  } catch { /* self-heal must never break a tick */ }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const lock = join(HERE, ".lock");
  let weWroteLock = false;
  try {
    const cfg = await loadConfig();
    // Pre-flight: only skip if disk is GENUINELY out of space (a few hundred MB). The
    // skip is non-destructive — rows stay queued and resume automatically once space
    // frees, so a near-full-but-fine machine (Marshall routinely runs at ~5 GB free)
    // keeps working normally.
    const guard = await preflightDisk({
      minFreeBytes: cfg.minFreeBytes ?? 500 * 1024 ** 2, // ~500 MB render headroom, not a multi-GB cushion
      dir: HERE,
    });
    if (!guard.ok) {
      console.error(new Date().toISOString(), `worker idle: very low disk (${Math.round((guard.free || 0) / 1048576)} MB free); queue left untouched, resumes automatically once space frees`);
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
    weWroteLock = true;
    const { getLastDigest, setLastDigest } = await stateGetSet();
    const notifier = makeNotifier(cfg);
    const postiz = makePostizClient();

    // Eats on 601 date automation — only wired when config.autoEvents.enabled is true
    // and the site dir is configured (stays dormant otherwise).
    let autoEvents = null;
    const ae = cfg.autoEvents;
    if (ae && ae.enabled && ae.siteDir && ae.clientId) {
      const runClaude = makeRunClaude({ claudeBin: cfg.claudeBin || "claude", model: cfg.model });
      const extract = makeExtractor({
        runClaude,
        today: () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }),
      });
      const git = makeGit(ae.siteDir);
      const io = makeEventsIO(ae.siteDir);
      autoEvents = makeAutoEvents({
        autoClientId: ae.clientId,
        extract,
        syncSite: (entry) => syncSiteEvent({ entry, git, io }),
        apiUpdate,
        notifier,
      });
    }

    // Deterministic website deploy lane — wired only when config.sites has entries
    // (dormant otherwise). Each entry maps a clientId to its site working dir + live URL:
    //   "sites": { "eats-on-601": { "dir": "/…/Eats On 601 Website", "liveUrl": "https://eatson601.com" } }
    // prepare() loads the drain's manifest (worker/out/<id>/manifest.json) + scratch files
    // and binds the git/io/live adapters for that client's repo.
    let siteShipper = null;
    if (cfg.sites && Object.keys(cfg.sites).length) {
      const prepareSite = async (r) => {
        const site = cfg.sites[r.clientId];
        if (!site || !site.dir || !site.liveUrl) return { error: `no deploy config for client "${r.clientId}"` };
        const outDir = join(HERE, "out", r.id);
        let manifest;
        try {
          manifest = JSON.parse(await readFile(join(outDir, "manifest.json"), "utf8"));
        } catch (e) {
          return { error: `no deploy manifest at worker/out/${r.id}: ${e.message}` };
        }
        if (!Array.isArray(manifest.files) || manifest.files.length === 0) return { error: "deploy manifest lists no files" };
        return {
          manifest,
          git: makeRepoGit(site.dir),
          io: makeFilesIO(site.dir, join(outDir, "scratch")),
          live: makeLive(site.liveUrl),
          liveUrl: site.liveUrl,
        };
      };
      siteShipper = makeSiteShipper({ apiUpdate, notifier, prepare: prepareSite });
    }

    // Schedule-sync lane — wired only when at least one site has schedule.enabled
    // (dormant otherwise). It reuses the same site dir/liveUrl as the deploy lane, and
    // constructs the real git/io/live per client exactly like the site lane above, but
    // with schedule-sync's makeScheduleIO (direct on-disk read/apply of schedule.json).
    let scheduleSync = null;
    if (cfg.sites && Object.values(cfg.sites).some((s) => s && s.schedule && s.schedule.enabled)) {
      const prepareScheduleSite = async (clientId, site) => ({
        git: makeRepoGit(site.dir),
        io: makeScheduleIO(site.dir),
        live: makeLive(site.liveUrl),
        config: site.schedule,
      });
      scheduleSync = ({ all }) => runScheduleSync({ cfg, all, prepare: prepareScheduleSite });
    }

    // Truck-post lane — wired only when at least one site has schedule.enabled (dormant
    // otherwise). Submits+queues the day-of (and, on the draft day, the monthly) food-truck
    // post through the same drain→auto-approve→publish pipeline. Reuses the tick's `all`.
    let truckPosts = null;
    if (cfg.sites && Object.values(cfg.sites).some((s) => s && s.schedule && s.schedule.enabled)) {
      truckPosts = ({ all, now }) => runTruckPosts({ cfg, all, now });
    }

    const res = await runOnce({
      apiBase: cfg.execUrl,
      adminToken: cfg.adminToken,
      caps: cfg.caps || { draft: 5, ship: 5 },
      drainer: spawnClaudeDrain({ claudeBin: cfg.claudeBin || "claude", model: cfg.model, oauthToken: cfg.claudeOauthToken, timeoutMs: cfg.drainTimeoutMs ?? 10 * 60 * 1000 }),
      shipper: makeShipper({ fetchIntegrations: () => postiz.listIntegrations(), postiz, apiUpdate, notifier }),
      siteShipper,
      scheduleSync,
      truckPosts,
      autoEvents,
      notifier,
      digestHour: cfg.digestHour ?? 8,
      getLastDigest,
      setLastDigest,
      orphanMaxAgeMs: (cfg.orphanMaxAgeMinutes ?? 15) * 60 * 1000,
      maxRequeues: cfg.maxRequeues ?? 3,
    });
    console.log(new Date().toISOString(), "drain:", JSON.stringify(res));
    await recordTickOutcome({ fetchOk: true });
  } catch (e) {
    console.error(new Date().toISOString(), "poller error:", e.message);
    // Self-heal the macOS background-network wedge: after sleep/wake, every
    // launchd tick can fail its first fetch ("fetch failed") until the JOB is
    // relaunched (proven 2026-07-02 — 4h dark). Count consecutive fetch
    // failures; at threshold, notify and relaunch our own launchd job.
    if (/^fetch all failed: network error/.test(e.message)) {
      await recordTickOutcome({ fetchOk: false });
    }
  } finally {
    // Only remove the lock if THIS process wrote it — an early throw (e.g. bad
    // config) must never delete a lock held by another live drain.
    if (weWroteLock) { try { unlinkSync(lock); } catch {} }
  }
}
