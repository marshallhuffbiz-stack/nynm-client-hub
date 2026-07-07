// worker/daily-truck-post.mjs — the day-of 8 AM ET auto-post for Eats on 601. Reads
// today's (ET) scheduled trucks fresh from the backend, assembles a branded lineup
// graphic spec + caption (DRY-RUN — the render+publish are injected seams), and on any
// publish failure alerts (ntfy) AND drops a fallback `post` draft into the Desk so it's
// never silently lost. Idempotent per-day so a re-run can't double-post.
//
// All outward effects are injected (fetchState, publish, createDraft, notify, now,
// alreadyPostedFor) → the whole flow is unit-tested without touching a live service.
import { etOffset } from "./events-auto.mjs";
import { hoursDisplay } from "./schedule-sync.mjs";

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// FB before IG — matches the post skill's anti-burst stagger (never two channels same minute).
const CHANNELS_ORDER = ["facebook", "instagram"];

// "Today" as a YYYY-MM-DD wall-clock date in America/New_York, DST-aware. We shift the
// UTC instant by the ET offset and read the calendar date of the shifted instant — a
// UTC time that is still "yesterday" in ET resolves to the ET date, not the UTC date.
// etOffset needs a ymd to pick EST/EDT; the UTC date is a safe seed (the offset only
// changes on the 2 AM DST-transition Sundays, and 8 AM cron never lands in that hour).
export function todayInET(now = new Date()) {
  const seedYmd = now.toISOString().slice(0, 10);
  const offH = Number(etOffset(seedYmd).slice(0, 3)); // "-04:00" -> -4
  const shifted = new Date(now.getTime() + offH * 3600 * 1000);
  return shifted.toISOString().slice(0, 10);
}

function displayDate(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return `${WD[dt.getUTCDay()]} · ${MON[m - 1]} ${d}`;
}

// Today's SCHEDULED bookings for `dateStr` (ET date), sorted by start time.
export function selectDayBookings(bookings, dateStr) {
  return (bookings || [])
    .filter((b) => b && b.status === "scheduled" && b.date === dateStr)
    .sort((a, b) => String(a.startTime || "").localeCompare(String(b.startTime || "")));
}

// Assemble the branded-lineup render inputs + caption (DRY-RUN). The `render` object is
// what a live branded-social-post render call would consume; the caption is the FB/IG
// copy. No renderer is invoked here — `publish` is the injected seam that would.
export function buildDailyPlan(dayBookings, vendors, { date }) {
  const byId = new Map();
  for (const v of vendors || []) if (v && v.id) byId.set(v.id, v);
  const lineup = dayBookings.map((b) => {
    const reg = byId.get(b.vendorId) || {};
    return {
      id: b.vendorId,
      name: reg.name || b.vendorName || "Food truck",
      category: reg.category || "",
      price: reg.price || "",
      hours: hoursDisplay(b.startTime, b.endTime),
    };
  });

  const names = lineup.map((v) => v.name);
  const lines = lineup.map((v) => (v.hours ? `${v.name} (${v.hours})` : v.name));
  const caption =
    names.length === 1
      ? `On the lot today: ${lines[0]}. Come hungry! Eats on 601, ${displayDate(date)}.`
      : `On the lot today: ${lines.join(", ")}. Come hungry! Eats on 601, ${displayDate(date)}.`;

  return {
    render: {
      brand: "eats-on-601",
      template: "daily-lineup",
      date,
      display: displayDate(date),
      vendors: lineup,
    },
    caption,
    channelsOrder: [...CHANNELS_ORDER],
  };
}

// Run the day-of post. Deps:
//   fetchState()        → backend admin payload { vendors[], bookings[] } (fresh)
//   publish(plan)       → publish the plan to Postiz FB→IG; returns {ok:true,...} or throws/{ok:false}
//   createDraft(draft)  → create a `post` request in the Desk (fallback on failure)
//   notify(n)           → ntfy push ({title,message,urgent})
//   now                 → clock
//   alreadyPostedFor(d) → idempotency guard: true if we already posted for date d
export async function runDailyPost({ fetchState, publish, createDraft, notify, now = new Date(), alreadyPostedFor }) {
  const date = todayInET(now);

  if (alreadyPostedFor && (await alreadyPostedFor(date))) {
    return { posted: false, reason: "already-posted", date };
  }

  const state = (await fetchState()) || {};
  const bookings = state.bookings || [];
  const vendors = state.vendors || [];

  const dayBookings = selectDayBookings(bookings, date);
  if (dayBookings.length === 0) {
    return { posted: false, reason: "no-trucks", date };
  }

  const plan = buildDailyPlan(dayBookings, vendors, { date });

  // LIVE ACTIVATION SEAM: `publish` is where the branded-social-post render + Postiz
  // FB→IG staggered post happen when wired live. Here it's injected and mocked in tests.
  let result;
  try {
    result = await publish(plan);
  } catch (e) {
    result = { ok: false, error: e && e.message ? e.message : String(e) };
  }

  if (result && result.ok) {
    return { posted: true, date, plan, result };
  }

  // Failure → alert AND drop a fallback Desk draft so it's never silently lost.
  const reason = (result && result.error) || "publish failed";
  try {
    if (notify) await notify({ title: "Eats daily post failed", message: `Auto-post for ${date} failed: ${reason}. A draft is waiting in the Desk.`, urgent: true });
  } catch { /* non-fatal */ }
  let draftRes = null;
  try {
    if (createDraft) {
      draftRes = await createDraft({
        type: "post",
        clientId: "eats-on-601",
        caption: plan.caption,
        render: plan.render,
        note: "daily truck post failed to auto-publish — review and post manually",
      });
    }
  } catch { /* non-fatal — the ntfy alert already fired */ }

  return { posted: false, fallback: true, date, reason, plan, draftRes };
}
