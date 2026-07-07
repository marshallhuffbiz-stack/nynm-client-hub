// worker/schedule-sync.mjs — build src/content/schedule.json (and, when explicitly
// enabled, src/content/vendors.json) for the Eats on 601 website from the backend's
// booking/vendor state, then deploy the change through the same push+verify lane as
// site-apply.mjs. Runs on the poller tick (plain Node, git allowed), NOT the sandboxed
// drain — same trust boundary as site-sync.mjs / site-apply.mjs.
//
// Everything outward (backend read, git, file IO, live verify) is injected so the
// orchestration is unit-tested without touching a real repo or a live service.
import { etIso, etOffset, slugify } from "./events-auto.mjs";

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "Sat · Jul 11" — mirrors events-auto's private displayDate (noon-UTC weekday is TZ-safe).
function displayDate(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return `${WD[dt.getUTCDay()]} · ${MON[m - 1]} ${d}`;
}

// Compact a 24-hour "HH:MM" booking time into the website's display style:
//   "11:00" -> "11A", "19:00" -> "7P", "12:00" -> "12", "12:30" -> "12:30P".
// (events-auto's compactTime takes a human "11 AM" string, not "HH:MM", so it can't be
// reused here — bookings carry 24-hour times from the backend.)
export function compactHour(hhmm) {
  const m = String(hhmm == null ? "" : hhmm).trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!m) return "";
  let h = Number(m[1]);
  const min = m[2];
  const pm = h >= 12;
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  const mm = min === "00" ? "" : `:${min}`;
  // Noon has no meridiem marker in the site style ("12–5P"); everything else marks A/P.
  const suffix = h === 12 && min === "00" ? "" : pm ? "P" : "A";
  return `${h12}${mm}${suffix}`;
}

// "11:00"–"19:00" -> "11A–7P"; a single time -> that time; nothing -> "".
export function hoursDisplay(startTime, endTime) {
  const s = compactHour(startTime);
  const e = compactHour(endTime);
  if (s && e) return `${s}–${e}`;
  return s || e || "";
}

// Build the schedule.json array (§4.3): one object per date with ≥1 SCHEDULED booking,
// each carrying that date's vendors[]. Pure + deterministic.
//   { id, date, isoDate, display, vendors:[{id,name,category,price,hours}] }
// id === date (the website's Astro loader REQUIRES `id` or the collection fails to load).
export function buildSchedule(bookings, vendors, { now } = {}) {
  const rows = (bookings || []).filter((b) => b && b.status === "scheduled" && b.date);
  const byId = new Map();
  for (const v of vendors || []) if (v && v.id) byId.set(v.id, v);

  const byDate = new Map();
  for (const b of rows) {
    if (!byDate.has(b.date)) byDate.set(b.date, []);
    const reg = byId.get(b.vendorId) || {};
    byDate.get(b.date).push({
      id: b.vendorId || slugify(b.vendorName || ""),
      name: reg.name || b.vendorName || "Food truck",
      category: reg.category || "",
      price: reg.price || "",
      hours: hoursDisplay(b.startTime, b.endTime),
    });
  }

  const dates = [...byDate.keys()].sort();
  return dates.map((date) => {
    // isoDate anchors the day at its earliest booking start (ET-aware), so the site's
    // forward-looking filter keeps the day until it passes.
    const dayVendors = byDate.get(date);
    const startTimes = rows.filter((b) => b.date === date).map((b) => b.startTime).filter(Boolean).sort();
    const start24 = (startTimes[0] || "09:00") + ":00";
    return {
      id: date,
      date,
      isoDate: etIso(date, start24),
      display: displayDate(date),
      vendors: dayVendors,
    };
  });
}

// Project the vendors.json array from the registry (active vendors only).
//   { id, name, category, price, tagline }
// IMPLEMENTED + unit-tested but NOT wired into reconcile() by default — see the guard in
// reconcile and the SAFETY note there.
export function projectVendors(vendors) {
  return (vendors || [])
    .filter((v) => v && v.active)
    .map((v) => ({ id: v.id, name: v.name, category: v.category || "", price: v.price || "", tagline: v.tagline || "" }));
}

// Serialize a content array the way the site expects (pretty JSON + trailing newline),
// matching makeEventsIO.write in site-sync.mjs so an unchanged file diffs byte-identical.
function serialize(arr) {
  return JSON.stringify(arr, null, 2) + "\n";
}

// Reconcile the website's schedule.json (and optionally vendors.json) with the backend.
// Injected deps: fetchState (backend read), git/io/live (deploy, mirrors site-apply),
// config, now. Returns:
//   { ok:true,  changed:true,  verified:true }          → deployed + confirmed live
//   { ok:true,  changed:false }                         → idempotent no-op (already current)
//   { ok:false, skipped:true, reason }                  → guard tripped (off-main/dirty/pull)
//   { ok:false, changed:true, verified:false, reason }  → pushed but not confirmed live
//   { ok:false, reason }                                → a git step failed
export async function reconcile({ fetchState, git, io, live, config = {}, now = new Date() }) {
  const scheduleRel = config.scheduleFile || "src/content/schedule.json";
  const vendorsRel = config.vendorsFile || "src/content/vendors.json";

  const state = (await fetchState()) || {};
  const bookings = state.bookings || [];
  const vendors = state.vendors || [];

  // Build the staged content. schedule.json is always projected. vendors.json is
  // projected ONLY when config.schedule.projectVendors === true.
  //
  // SAFETY: projectVendors defaults FALSE. The backend registry currently holds only the
  // ~4 seed vendors, but the live site's vendors.json is the full 36-vendor directory.
  // Projecting now would OVERWRITE 36 vendors with 4 — deleting the directory. Keep
  // projection OFF until the registry is seeded with all 36; then flip the config flag.
  const projectVendorsNote =
    "projectVendors is OFF by default — the registry holds only ~4 seed vendors, so projecting would DELETE the site's 36-vendor directory. Keep it off until the registry is seeded with the full 36.";

  const staged = [{ rel: scheduleRel, content: serialize(buildSchedule(bookings, vendors, { now })) }];
  if (config.projectVendors === true) {
    staged.push({ rel: vendorsRel, content: serialize(projectVendors(vendors)) });
  }

  // Diff each staged file against the repo's current content. Unchanged everywhere → no-op.
  const changedFiles = [];
  for (const f of staged) {
    let cur = null;
    try { cur = await io.readFile(f.rel); } catch { cur = null; }
    if (cur !== f.content) changedFiles.push(f);
  }
  if (changedFiles.length === 0) {
    return { ok: true, changed: false, note: projectVendorsNote };
  }

  const files = staged.map((f) => f.rel);

  // Guards (reuse site-sync guard style): on main, target files clean, pull-first.
  const branch = await git.branch();
  if (!branch.ok || branch.out !== "main") {
    return { ok: false, skipped: true, reason: `site repo not on main (on "${branch.out || branch.err}")`, note: projectVendorsNote };
  }
  const status = await git.status(files);
  if (status.ok && status.out) {
    return { ok: false, skipped: true, reason: "schedule files have uncommitted local changes — not touching them", note: projectVendorsNote };
  }
  const pull = await git.pull();
  if (!pull.ok) {
    return { ok: false, skipped: true, reason: "git pull failed: " + (pull.err || pull.out), note: projectVendorsNote };
  }

  // Stage the full built content (not just the changed subset) so io.apply mirrors
  // site-apply's copy-in-and-commit-only-these-files behavior.
  const applied = await io.apply(staged);
  const add = await git.add(files);
  if (!add.ok) return { ok: false, verified: false, reason: "git add failed: " + (add.err || add.out), note: projectVendorsNote };
  const commit = await git.commit("schedule: sync food-truck schedule [auto]");
  if (!commit.ok) return { ok: false, verified: false, reason: "git commit failed: " + (commit.err || commit.out), note: projectVendorsNote };
  const push = await git.push();
  if (!push.ok) return { ok: false, verified: false, reason: "git push failed: " + (push.err || push.out), note: projectVendorsNote };

  // Verify the change is actually live: assert a truck name from the schedule is present.
  const firstDay = buildSchedule(bookings, vendors, { now })[0];
  const presentOnLive = firstDay && firstDay.vendors[0] ? [firstDay.vendors[0].name] : [];
  const v = await live.check({ absentOnLive: [], presentOnLive });
  if (v.ok) return { ok: true, changed: true, verified: true, applied, note: projectVendorsNote };
  return { ok: false, changed: true, verified: false, reason: "pushed but not confirmed live: " + v.reason, note: projectVendorsNote };
}
