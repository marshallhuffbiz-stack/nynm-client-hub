// worker/events-auto.mjs — pure logic for the Eats on 601 date-driven automation:
// when a request names a date, we put the vendor/event on the website and schedule a
// day-of 8 AM post. All side effects (LLM extraction, git push, Postiz) live elsewhere;
// this module is the deterministic, unit-tested core.

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function slugify(s) {
  return String(s == null ? "" : s)
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Stable idempotency key for a dated event so we never double-process it.
export function eventKey(clientId, ymd, title) {
  return `${clientId}|${ymd}|${slugify(title)}`;
}

// Day-of-month of the Nth Sunday of a month (month0 = 0-indexed).
function nthSunday(year, month0, n) {
  const first = new Date(Date.UTC(year, month0, 1));
  const firstSun = 1 + ((7 - first.getUTCDay()) % 7);
  return firstSun + (n - 1) * 7;
}

// America/New_York UTC offset for a calendar date: EDT (-04:00) from the 2nd Sunday
// of March to the 1st Sunday of November, EST (-05:00) otherwise. (8 AM wall time is
// never inside the 2 AM transition hour, so the date alone is unambiguous.)
export function etOffset(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dstStart = nthSunday(y, 2, 2); // 2nd Sunday March
  const dstEnd = nthSunday(y, 10, 1); // 1st Sunday November
  const afterStart = m > 3 || (m === 3 && d >= dstStart);
  const beforeEnd = m < 11 || (m === 11 && d < dstEnd);
  return afterStart && beforeEnd ? "-04:00" : "-05:00";
}

export function etIso(ymd, hhmmss = "08:00:00") {
  return `${ymd}T${hhmmss}${etOffset(ymd)}`;
}

// The scheduled publish time for the day-of post: 8 AM ET on the event day.
export function dayOfPostIso(ymd) {
  return etIso(ymd, "08:00:00");
}

function validYmd(ymd) {
  return typeof ymd === "string" && /^\d{4}-\d{2}-\d{2}$/.test(ymd);
}

// Confidence gate: only automate when the extractor is confident, gave a usable title,
// and a valid date that is today or in the future. Anything else falls back to the
// normal draft-for-Marshall flow.
export function isConfident(ex, now = new Date()) {
  if (!ex || ex.hasDate === false || ex.confident === false) return false;
  if (!ex.title || !String(ex.title).trim()) return false;
  if (!validYmd(ex.ymd)) return false;
  const endOfDay = Date.parse(`${ex.ymd}T23:59:59${etOffset(ex.ymd)}`);
  if (Number.isNaN(endOfDay)) return false;
  return endOfDay >= now.getTime();
}

function displayDate(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12)); // noon UTC: TZ-safe weekday
  return `${WD[dt.getUTCDay()]} · ${MON[m - 1]} ${d}`;
}

// Compact a display time ("11 AM" -> "11A", "4 PM" -> "4P", "11:30 AM" -> "11:30A").
function compactTime(t) {
  return String(t || "")
    .trim()
    .replace(/:00(?=\s*[AaPp])/, "")
    .replace(/\s*([AaPp])[Mm]/, (_, ap) => ap.toUpperCase());
}

// Build the events.json entry. `kind`: "vendor-day" (a truck visit, lighter card) or
// "event" (a lot event). isoDate carries the event day so the site's forward-looking
// filter keeps it until it passes, then drops it automatically.
export function buildSiteEvent(ex) {
  const ymd = ex.ymd;
  const kind = ex.kind === "event" ? "event" : "vendor-day";
  const title = (ex.title && String(ex.title).trim()) || "Food truck";
  const start24 = ex.startTime24 || "09:00:00";
  const timeRange =
    ex.timeStart && ex.timeEnd
      ? `${compactTime(ex.timeStart)}–${compactTime(ex.timeEnd)}`
      : ex.timeStart
        ? compactTime(ex.timeStart)
        : "";
  const kindLabel = kind === "event" ? "EVENT" : "FOOD TRUCK";
  const meta = [timeRange, kindLabel].filter(Boolean).join(" · ");
  return {
    id: `${slugify(title)}-${ymd}`,
    kind,
    date: displayDate(ymd),
    isoDate: etIso(ymd, start24),
    title,
    description: ex.description || "",
    meta,
  };
}

// Idempotent upsert into the events.json array: replace an entry with the same id in
// place, otherwise append. Merging the same entry twice yields the same array.
export function mergeSiteEvents(existing = [], entry) {
  const arr = (existing || []).slice();
  const i = arr.findIndex((e) => e && e.id === entry.id);
  if (i >= 0) arr[i] = entry;
  else arr.push(entry);
  return arr;
}
