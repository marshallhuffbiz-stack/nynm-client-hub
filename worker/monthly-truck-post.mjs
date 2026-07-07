// worker/monthly-truck-post.mjs — the monthly schedule draft for Eats on 601. Gathers a
// month's scheduled bookings, assembles a branded monthly-calendar render spec + caption,
// and creates a `post` request draft (via the injected createDraft seam) that lands in the
// Desk for Marshall's approval — the existing approve→publish lane then ships it.
//
// Live backend request-creation + live Postiz are DEFERRED activation seams: createDraft
// is injected (mocked in tests) and, when wired live, calls the backend submitRequest
// action to create a `post` request in `ready` stage. Nothing here hits a live service.
import { hoursDisplay } from "./schedule-sync.mjs";

const MON_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function displayDate(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return `${WD[dt.getUTCDay()]} · ${MON[m - 1]} ${d}`;
}

// The YYYY-MM one calendar month after `now` (ET-agnostic; month rollover only).
export function nextMonth(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-indexed
  const d = new Date(Date.UTC(y, m + 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Scheduled bookings whose date falls in `YYYY-MM`, sorted ascending by date.
export function bookingsForMonth(bookings, month) {
  return (bookings || [])
    .filter((b) => b && b.status === "scheduled" && typeof b.date === "string" && b.date.startsWith(month + "-"))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// Assemble the monthly-calendar render inputs + caption for `month` (YYYY-MM). One entry
// per scheduled day (multiple trucks per day grouped into that day's vendors[]).
export function buildMonthlyDraft(bookings, { month, now = new Date() } = {}) {
  const rows = bookingsForMonth(bookings, month);
  const byDate = new Map();
  for (const b of rows) {
    if (!byDate.has(b.date)) byDate.set(b.date, []);
    byDate.get(b.date).push({
      id: b.vendorId,
      name: b.vendorName || "Food truck",
      hours: hoursDisplay(b.startTime, b.endTime),
    });
  }
  const days = [...byDate.keys()].sort().map((date) => ({
    date,
    display: displayDate(date),
    vendors: byDate.get(date),
  }));

  const [y, m] = month.split("-").map(Number);
  const monthLabel = `${MON_FULL[m - 1]} ${y}`;
  const caption = days.length
    ? `Here's who's rolling into Eats on 601 this ${MON_FULL[m - 1]}! Save the dates and come hungry all month long.`
    : `${monthLabel} lineup coming soon at Eats on 601 — check back for the trucks!`;

  return {
    render: {
      brand: "eats-on-601",
      template: "monthly-calendar",
      month,
      monthLabel,
      days,
    },
    caption,
  };
}

// Create the monthly draft. Deps:
//   fetchState()       → backend admin payload { vendors[], bookings[] }
//   createDraft(draft) → create a `post` request draft (DEFERRED live seam: backend
//                        submitRequest → `ready` stage → Desk approval → publish lane)
//   now                → clock
//   month (optional)   → YYYY-MM; defaults to next month from `now` (on-demand callers
//                        pass the current month explicitly).
export async function runMonthly({ fetchState, createDraft, now = new Date(), month }) {
  const target = month || nextMonth(now);
  const state = (await fetchState()) || {};
  const bookings = state.bookings || [];

  const draft = buildMonthlyDraft(bookings, { month: target, now });

  // LIVE ACTIVATION SEAM: createDraft, when wired live, creates a `post` request in the
  // Desk (ready stage) for approval. Injected + mocked in tests.
  const res = await createDraft({
    type: "post",
    clientId: "eats-on-601",
    caption: draft.caption,
    render: draft.render,
    note: `monthly schedule draft for ${draft.render.monthLabel} — review and approve to publish`,
  });

  return { ok: !!(res && res.ok !== false), month: target, draft, res };
}
