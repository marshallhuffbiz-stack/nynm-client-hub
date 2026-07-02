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

// Cheap pre-filter: does this text plausibly name a date? Used to gate the (costly)
// Opus extraction so we don't spend a model call on obviously date-less requests.
const DATE_HINT = /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sept?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?|mon(day)?|tue(s|sday)?|wed(nesday)?|thu(r|rs|rsday)?|fri(day)?|sat(urday)?|sun(day)?|today|tonight|tomorrow|this\s+(week|weekend)|next\s+(week|weekend)|\d{1,2}\s*\/\s*\d{1,2}|\b\d{1,2}(st|nd|rd|th)\b|\d{4}-\d{2}-\d{2})\b/i;
export function mightHaveDate(text) {
  return DATE_HINT.test(String(text || ""));
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

// Convert an extractor-style human time ("11 AM", "7:05 pm") or a 24-hour "HH:MM"
// portal time ("19:30") to "HH:MM:SS" for isoDate. Unparseable -> "" so the caller
// can fall back. (buildSiteEvent used to expect `startTime24`, which no caller ever
// set — every site entry silently got the 09:00 default even when a start time was
// extracted; this derives it from the time we actually have.)
export function to24h(t) {
  const s = String(t == null ? "" : t).trim();
  if (!s) return "";
  let m = s.match(/^([01]?\d|2[0-3]):([0-5]\d)$/); // already 24-hour "HH:MM"
  if (m) return `${String(Number(m[1])).padStart(2, "0")}:${m[2]}:00`;
  m = s.match(/^(\d{1,2})(?::([0-5]\d))?\s*([AaPp])\.?[Mm]\.?$/); // "11 AM" / "7:05 pm"
  if (!m) return "";
  let h = Number(m[1]);
  if (h < 1 || h > 12) return "";
  const min = m[2] || "00";
  const pm = m[3].toLowerCase() === "p";
  if (pm && h !== 12) h += 12;
  if (!pm && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${min}:00`;
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
  const start24 = ex.startTime24 || to24h(ex.timeStart) || "09:00:00";
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
