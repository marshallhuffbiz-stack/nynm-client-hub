// worker/monthly-truck-post.mjs — the monthly schedule-graphic post for a schedule-enabled
// client (e.g. Eats on 601). Like the daily post, this does NOT render or publish anything
// itself — the drain renders the branded month-at-a-glance graphic and the existing
// approve→publish lane ships it. The ONLY difference from daily: monthly is ALWAYS
// Marshall-approved (autoApprove:false, always) — it never auto-approves.
//
// runMonthly is the same idempotent state machine as runDailyPost, keyed on
// `<clientId>-monthly-<yyyymm>`. The request's existence + stage IS the state (no state file),
// so a re-run across the flaky VPS connection never creates a duplicate and can recover a
// partial create. All outward effects are dependency-injected.
import { hoursDisplay } from "./schedule-sync.mjs";

const MON_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function displayDate(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return `${WD[dt.getUTCDay()]} · ${MON[m - 1]} ${d}`;
}

// Scheduled bookings whose date falls in `YYYY-MM` for `clientId`, sorted ascending by date.
export function bookingsForMonth(bookings, month, clientId) {
  return (bookings || [])
    .filter(
      (b) =>
        b &&
        b.status === "scheduled" &&
        typeof b.date === "string" &&
        b.date.startsWith(month + "-") &&
        (clientId == null || b.clientId === clientId)
    )
    .sort((a, b) => a.date.localeCompare(b.date));
}

// Build the month's post REQUEST fields (pure): title + a description that lays out the
// month's schedule (one line per scheduled day, trucks + hours) and asks the drain for a
// branded month-at-a-glance schedule graphic, plus the AUTO comment for the drain.
export function buildMonthlyPost(bookings, vendors, { month, clientId, now } = {}) {
  const byId = new Map();
  for (const v of vendors || []) if (v && v.id) byId.set(v.id, v);

  const rows = bookingsForMonth(bookings, month, clientId);
  const byDate = new Map();
  for (const b of rows) {
    if (!byDate.has(b.date)) byDate.set(b.date, []);
    const reg = byId.get(b.vendorId) || {};
    byDate.get(b.date).push({
      name: reg.name || b.vendorName || "Food truck",
      hours: hoursDisplay(b.startTime, b.endTime),
    });
  }
  const days = [...byDate.keys()].sort();

  const [y, m] = month.split("-").map(Number);
  const monthLabel = `${MON_FULL[m - 1]} ${y}`;

  const title = `Monthly schedule — ${monthLabel}`;

  const scheduleLines = days.map((date) => {
    const vs = byDate.get(date);
    const list = vs.map((v) => (v.hours ? `${v.name} (${v.hours})` : v.name)).join(", ");
    return `${displayDate(date)}: ${list}`;
  });

  const description = days.length
    ? `Create a branded month-at-a-glance schedule graphic for Eats on 601 for ${monthLabel}, ` +
      `showing every food-truck day and its trucks + hours, plus a short on-brand caption ` +
      `inviting the community to save the dates. Schedule for ${monthLabel}: ${scheduleLines.join("; ")}.`
    : `Create a branded month-at-a-glance schedule graphic for Eats on 601 for ${monthLabel}. ` +
      `No trucks are booked yet — design a "lineup coming soon, check back" graphic with a short on-brand caption.`;

  const comment =
    `Monthly schedule post for ${monthLabel}. Design the month's food-truck calendar as a ` +
    `branded graphic and write a short save-the-dates caption. Marshall approves this before it ships.`;

  return { title, description, comment, monthLabel, dayCount: days.length };
}

// The YYYY-MM of `now` (the month whose schedule we're announcing). ET-agnostic (month
// granularity only — the exact instant never straddles a month for the 25th-of-month gate).
export function monthOf(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Create the monthly draft. Same idempotent state machine as runDailyPost, but autoApprove
// is ALWAYS false (monthly is always Marshall-approved). Deps mirror runDailyPost. Keyed on
// `<clientId>-monthly-<yyyymm>`. targetMonth overrides the month (else monthOf(now)).
//   no request for crid                → submit + queue+markers → { created:true, id }
//   request exists, stage "submitted"  → queue+markers only (recover partial) → { queued:true, id }
//   request exists, later stage        → { skipped:true, stage } (idempotent)
export async function runMonthly({ all, submitRequest, updateRequest, now = new Date(), clientId, clientToken, targetMonth }) {
  const month = targetMonth || monthOf(now);
  const bookings = (all && all.bookings) || [];
  const vendors = (all && all.vendors) || [];
  const requests = (all && all.requests) || [];

  const crid = `${clientId}-monthly-${month.replace("-", "")}`;
  const existing = requests.find((r) => r && r.clientId === clientId && r.meta && r.meta.clientRequestId === crid);

  const { title, description, comment } = buildMonthlyPost(bookings, vendors, { month, clientId, now });

  // Monthly ALWAYS requires Marshall's approval → autoApprove:false. No scheduledFor (the
  // day-of anchor is a daily concept); the drain drafts, Marshall approves, the lane ships.
  const queuePatch = {
    action: "send",
    comment,
    meta: {
      ...(existing && existing.meta ? existing.meta : {}),
      autoEvent: {
        key: crid,
        month,
        autoApprove: false,
      },
    },
  };

  if (!existing) {
    const created = await submitRequest({ type: "post", title, description, attachments: [], clientRequestId: crid }, clientToken);
    const id = created && created.id;
    if (!id) return { created: false, reason: "submit-failed", month, res: created };
    await updateRequest(id, queuePatch);
    return { created: true, id, month };
  }

  if (existing.stage === "submitted") {
    await updateRequest(existing.id, queuePatch);
    return { queued: true, id: existing.id, month };
  }

  return { skipped: true, stage: existing.stage, id: existing.id, month };
}
