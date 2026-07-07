// worker/daily-truck-post.mjs — the day-of food-truck AUTO-POST for a schedule-enabled
// client (e.g. Eats on 601). This does NOT render or publish anything itself: the worker
// can't render branded graphics — the drain (headless Claude + branded-social-post skill)
// does. So a daily post is just a `type:"post"` REQUEST the existing pipeline handles:
//   submit (client token) → queue + auto-markers (updateRequest) → drain drafts it →
//   auto-approve (auto-events' autoApproveReady when meta.autoEvent.autoApprove) → publish.
//
// runDailyPost is a small, IDEMPOTENT state machine keyed on a deterministic clientRequestId
// (`<clientId>-daily-<ymd>`). The request's own existence + stage IS the state — there is NO
// separate state file — so a re-run across the flaky VPS connection never double-posts and
// can recover a partial create (a submit that landed but whose queue step never returned).
//
// All outward effects (submitRequest, updateRequest) are dependency-injected, so the whole
// flow is unit-tested without a live backend.
import { dayOfPostIso, todayInET } from "./events-auto.mjs";
import { hoursDisplay } from "./schedule-sync.mjs";

// Re-export so existing importers of todayInET from this module keep working.
export { todayInET };

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function displayDate(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12)); // noon UTC: TZ-safe weekday
  return `${WD[dt.getUTCDay()]} · ${MON[m - 1]} ${d}`;
}

// Today's SCHEDULED bookings for `dateStr` (ET date) belonging to `clientId`, sorted by
// start time so the lineup reads in the order trucks arrive.
export function selectDayBookings(bookings, dateStr, clientId) {
  return (bookings || [])
    .filter((b) => b && b.status === "scheduled" && b.date === dateStr && (clientId == null || b.clientId === clientId))
    .sort((a, b) => String(a.startTime || "").localeCompare(String(b.startTime || "")));
}

// Resolve a booking to a display { name, hours } using the vendor registry when present.
function resolveVendor(b, byId) {
  const reg = byId.get(b.vendorId) || {};
  return {
    name: reg.name || b.vendorName || "Food truck",
    hours: hoursDisplay(b.startTime, b.endTime),
  };
}

// Build the day-of post REQUEST fields (pure): the title + a description that lists today's
// trucks + hours and asks the drain for a branded "on the lot today" lineup graphic, plus
// the `comment` = the AUTO day-of instruction (mirrors auto-events' phrasing). Handles one
// truck and multiple trucks. `now` is accepted for symmetry/future use but unused here.
export function buildDailyPost(dayBookings, vendors, { ymd, now } = {}) {
  const byId = new Map();
  for (const v of vendors || []) if (v && v.id) byId.set(v.id, v);
  const lineup = (dayBookings || []).map((b) => resolveVendor(b, byId));

  const lines = lineup.map((v) => (v.hours ? `${v.name} (${v.hours})` : v.name));
  const names = lineup.map((v) => v.name);
  const display = displayDate(ymd);

  const title = `Daily lineup — ${display}`;

  const listSentence =
    names.length === 1
      ? `Today on the lot: ${lines[0]}.`
      : `Today on the lot: ${lines.join(", ")}.`;
  const description =
    `${listSentence} ` +
    `Create a branded "on the lot today" lineup graphic for Eats on 601 showing today's food ` +
    `truck${names.length === 1 ? "" : "s"} and hours, plus a short on-brand caption. ` +
    `Trucks & hours today (${display}): ${lines.join("; ")}.`;

  // Mirror auto-events' AUTO day-of phrasing so the drain treats this identically.
  const comment =
    `AUTO day-of post: publishes the morning of ${ymd}. Write it as a "today on the lot" ` +
    `announcement for Eats on 601's lineup — ${lines.join(", ")}. Keep it short and on-brand.`;

  return { title, description, comment };
}

// Run the day-of post. A small idempotent state machine. Deps:
//   all           → the tick's admin payload (has requests[], bookings[], vendors[], clients[])
//   submitRequest(request, clientToken)  → create a `post` request (client action); {ok,id}
//   updateRequest(id, patch)             → UPDATE-ONLY (404 if id missing)
//   now           → clock
//   config        → { autoApproveDaily } — whether the day-of post auto-approves (safe: default false)
//   clientId      → the schedule-enabled tenant (e.g. "eats-on-601")
//   clientToken   → that client's portal token (submitRequest forces the tenant from it)
//   targetYmd     → optional ET-date override (else todayInET(now))
//
// States (the request's existence + stage IS the state):
//   0 trucks today                         → { created:false, reason:"no-trucks" } (nothing created)
//   no request for crid                    → submit + queue+auto-markers → { created:true, id }
//   request exists, stage "submitted"      → queue+auto-markers only (recover a partial create) → { queued:true, id }
//   request exists, any later stage        → { skipped:true, stage } (already in flight/done — idempotent)
export async function runDailyPost({ all, submitRequest, updateRequest, now = new Date(), config = {}, clientId, clientToken, targetYmd }) {
  const ymd = targetYmd || todayInET(now);
  const bookings = (all && all.bookings) || [];
  const vendors = (all && all.vendors) || [];
  const requests = (all && all.requests) || [];

  const dayBookings = selectDayBookings(bookings, ymd, clientId);
  if (dayBookings.length === 0) {
    return { created: false, reason: "no-trucks", ymd };
  }

  const crid = `${clientId}-daily-${ymd}`;
  const existing = requests.find((r) => r && r.clientId === clientId && r.meta && r.meta.clientRequestId === crid);

  const { title, description, comment } = buildDailyPost(dayBookings, vendors, { ymd, now });

  // The auto-markers patch: submitted → queued (action:"send") + the meta.autoEvent shape the
  // drain/auto-approve read. autoApprove is gated by config (default false → Marshall approves).
  const queuePatch = {
    action: "send",
    comment,
    meta: {
      ...(existing && existing.meta ? existing.meta : {}),
      autoEvent: {
        key: crid,
        ymd,
        scheduledFor: dayOfPostIso(ymd),
        autoApprove: !!config.autoApproveDaily,
      },
    },
  };

  if (!existing) {
    // Fresh: create then queue. crid rides the submit so a retry that already created the
    // row (but whose response was lost) dedupes server-side instead of double-creating.
    const created = await submitRequest({ type: "post", title, description, attachments: [], clientRequestId: crid }, clientToken);
    const id = created && created.id;
    if (!id) return { created: false, reason: "submit-failed", ymd, res: created };
    await updateRequest(id, queuePatch);
    return { created: true, id, ymd };
  }

  if (existing.stage === "submitted") {
    // Partial create: the submit landed but the queue step never completed. Finish it —
    // don't re-submit (that would try to create a second row for the same crid).
    await updateRequest(existing.id, queuePatch);
    return { queued: true, id: existing.id, ymd };
  }

  // Already queued / drafting / ready / approved / done — leave it alone (idempotent).
  return { skipped: true, stage: existing.stage, id: existing.id, ymd };
}
