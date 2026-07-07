// Relay — client-facing PWA (request portal).
// Plain ES module, no build step. Talks to the shared API client.
import { portalApi, fileToPayload } from "../shared/api.js";
import { openLightbox } from "../shared/lightbox.js";
import { computeIdeas, buildCampaign } from "../shared/ideas.js";
import { resolveAccess, persistAccess, PORTAL_TOKEN_KEY, PORTAL_PIN_KEY } from "../shared/token.js";
import { installLaunchManifest } from "../shared/pwa.js";
import { dataCacheKey, readDataCache, writeDataCache } from "../shared/datacache.js";

/* ---------- token + api ---------- */

// localStorage, but never throw (Safari private mode / blocked storage).
function safeLocalStorage() {
  try { return window.localStorage; } catch { return null; }
}

// The token lives in ?c=… , but an installed home-screen app relaunches the
// manifest's start_url with no query string. Resolve from the URL first, then
// durable storage, so the installed app self-heals instead of dead-ending on
// "This link isn't valid." (Root-cause fix for the home-screen launch bug.)
const access = resolveAccess({
  search: location.search,
  storage: safeLocalStorage(),
  param: "c",
  pinParam: "pin",
  tokenKey: PORTAL_TOKEN_KEY,
  pinKey: PORTAL_PIN_KEY,
});
const token = access.token;
let pin = access.pin || "";
let api = portalApi(token, pin);

// Key for this client's on-device payload cache (stale-while-revalidate).
const DATA_CACHE_KEY = dataCacheKey("relay.portal.data", token);

// Recovered from storage (no ?c= in the URL) → put it back in the address bar so
// reloads and the dynamic manifest both see it.
if (token && access.source === "storage") {
  try {
    const u = new URL(location.href);
    u.searchParams.set("c", token);
    history.replaceState(null, "", u.href);
  } catch { /* non-fatal */ }
}

// Persist a verified token so future launches survive a dropped query string.
function rememberAccess() {
  persistAccess(safeLocalStorage(), { token, pin, tokenKey: PORTAL_TOKEN_KEY, pinKey: PORTAL_PIN_KEY });
}

// Replace the static manifest with one whose start_url carries the token, so
// "Add to Home Screen" records a launch link that reopens the correct portal.
async function setupLaunchManifest(tok) {
  try {
    const link = document.querySelector('link[rel="manifest"]');
    const manifestHref = new URL(link ? link.getAttribute("href") : "./manifest.webmanifest", location.href).href;
    let base;
    try {
      base = await (await fetch(manifestHref, { cache: "no-store" })).json();
    } catch {
      base = { name: "Relay by Not Your Normal Marketing", short_name: "Relay", display: "standalone", background_color: "#F2F2F7", theme_color: "#F2F2F7" };
    }
    installLaunchManifest({ doc: document, base, href: location.href, manifestHref, param: "c", token: tok });
  } catch { /* non-fatal: the storage-restore layer still recovers the token */ }
}

if (token) setupLaunchManifest(token);

/* ---------- element refs ---------- */

const $ = (id) => document.getElementById(id);

const views = {
  loading: $("view-loading"),
  badlink: $("view-badlink"),
  offline: $("view-offline"),
  pin: $("view-pin"),
  app: $("view-app"),
};

const clientNameEl = $("client-name");
const brandLogoEl  = $("brand-logo");

// Brand logos bundled in the repo — keyed by clientId (same slugs as the Desk).
const BRAND_LOGOS = {
  "the-o":       "../shared/brands/the-o.png",
  "eats-on-601": "../shared/brands/eats-on-601.png",
};

const typeChips = $("type-chips");
const requestForm = $("request-form");
const eventForm = $("event-form");

const reqDesc = $("req-desc");
const reqDescLabel = $("req-desc-label");
const reqFiles = $("req-files");
const reqCamera = $("req-camera");
const reqSubmit = $("req-submit");
const thumbsEl = $("thumbs");
const uploadStatus = $("upload-status");

const evtTitle = $("evt-title");
const evtDate = $("evt-date");
const evtTime = $("evt-time");
const evtEndTime = $("evt-end-time");
const evtDesc = $("evt-desc");
const evtSubmit = $("evt-submit");

const requestsList = $("requests-list");
const eventsList = $("events-list");
const ideasSection = $("ideas-section");
const ideasList = $("ideas-list");

// --- Food Trucks surface ---
const surfaceChips = $("surface-chips");
const surfaceRequests = $("surface-requests");
const surfaceTrucks = $("surface-trucks");
const calTitle = $("cal-title");
const calGrid = $("cal-grid");
const calPrev = $("cal-prev");
const calNext = $("cal-next");
const dayDetail = $("day-detail");
const dayDetailLabel = $("day-detail-label");
const dayTrucks = $("day-trucks");
const truckSearch = $("truck-search");
const truckResults = $("truck-results");
const newTruckForm = $("new-truck-form");
const ntName = $("nt-name");
const ntCategory = $("nt-category");
const ntPrice = $("nt-price");
const ntTagline = $("nt-tagline");
const ntCancel = $("nt-cancel");
const truckCategories = $("truck-categories");
// Booking editor sheet
const bookingSheet = $("booking-sheet");
const bookingForm = $("booking-form");
const bkSheetTitle = $("bk-sheet-title");
const bkSheetWhen = $("bk-sheet-when");
const bkStart = $("bk-start");
const bkEnd = $("bk-end");
const bkNote = $("bk-note");
const bkRepeatRow = $("bk-repeat-row");
const bkRepeat = $("bk-repeat");
const bkError = $("bk-error");
const bkSave = $("bk-save");
const bkCancel = $("bk-cancel");

const toastEl = $("toast");

/* ---------- constants ---------- */

// Placeholder copy tailored per request type. (Plain, NYNM voice.)
const DESC_HINTS = {
  post: {
    label: "What do you want to post?",
    placeholder: "What do you want to post? e.g. Promote our Friday sidewalk sale, 20% off",
  },
  website: {
    label: "What needs fixing on the site?",
    placeholder: "What needs fixing on the site? e.g. Update our hours and add the new phone number",
  },
  design: {
    label: "What do you need designed?",
    placeholder: "What do you need designed? e.g. A menu graphic for our new summer specials",
  },
  other: {
    label: "What do you need?",
    placeholder: "Send a photo or tell us anything — we'll take it from there.",
  },
};

// stage -> { label, badge color class }
// Client-facing status scheme: Received (gray) -> In progress (blue) -> Ready (green) -> Posted (gray).
const STAGE_LABELS = {
  submitted: "Received",
  queued: "In progress",
  drafting: "In progress",
  changes: "In progress",
  ready: "Ready",
  approved: "Ready",
  shipping: "Ready",
  done: "Posted",
  // A failed run is NYNM's problem to fix, not the client's — never show a
  // scary/stale state; the Desk surfaces it red on Marshall's side.
  error: "In progress",
};
const STAGE_BADGE = {
  submitted: "bone",   // New -> gray
  queued: "send",      // In progress -> blue
  drafting: "send",
  changes: "send",
  ready: "go",         // Ready -> green
  approved: "go",
  shipping: "go",
  done: "bone",        // Posted -> gray
  error: "send",
};

// "Posted" only makes sense for social work; website/design/other finish as "Done".
const DONE_LABEL_BY_TYPE = { post: "Posted", "event-promo": "Posted", event: "Posted" };

const TYPE_LABELS = {
  post: "Post",
  website: "Website fix",
  design: "Design",
  "event-promo": "Event promo",
  event: "Event",
  other: "Other",
};

/* ---------- state ---------- */

let selectedType = "post";
// Proactive idea suggestions currently shown (index referenced by the action buttons).
let currentIdeas = [];
// Successfully uploaded attachments for the in-progress request: {name,url,mime}
let pendingAttachments = [];
// Files chosen but not yet uploaded (in case a selection is mid-upload on submit).
let uploadingCount = 0;
let busy = false;
// Last payload applied to the page (source of truth for optimistic updates).
let currentData = null;
// Signature of the last rendered payload, so identical revalidations skip the
// re-render entirely (protects half-typed thread drafts from being wiped).
let lastRenderSig = "";
// When we last heard fresh data from the server (drives revalidate-on-return).
let lastLoadedAt = 0;

/* ---------- Food Trucks state ---------- */
let foodTrucksEnabled = false;      // gated by client.features.foodTrucks
let currentSurface = "requests";    // "requests" | "trucks"
let calYear = 0;                    // month currently shown in the calendar
let calMonth = 0;                   // 0-based
let selectedDate = "";             // "YYYY-MM-DD" of the open day-detail (or "")
// The booking editor sheet is reused for both "add" and "edit":
//   mode "add"  -> { vendorId } : create a booking (repeat helper offered)
//   mode "edit" -> { id }       : patch an existing booking's time/note
let sheetCtx = null;

/* ---------- view helpers ---------- */

function showView(name) {
  for (const [key, el] of Object.entries(views)) {
    if (!el) continue;
    el.classList.toggle("hidden", key !== name);
  }
}

// Keep the toast above the iOS software keyboard: the keyboard shrinks the
// visual viewport but not the layout viewport, so a bottom-fixed toast would
// render underneath it. Lift the toast by the covered height when needed.
function positionToast() {
  if (!toastEl) return;
  const vv = window.visualViewport;
  if (!vv) return;
  const covered = window.innerHeight - (vv.height + vv.offsetTop);
  toastEl.style.bottom = covered > 40 ? `${covered + 16}px` : "";
}
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", positionToast);
  window.visualViewport.addEventListener("scroll", positionToast);
}

let toastTimer = null;
function toast(message) {
  if (!toastEl) return;
  positionToast();
  toastEl.textContent = message;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2600);
}

function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ---------- formatting ---------- */

function stageBadge(stage, type) {
  let label = STAGE_LABELS[stage] || "Received";
  if (stage === "done") label = DONE_LABEL_BY_TYPE[type] || "Done";
  const color = STAGE_BADGE[stage] || "bone";
  return `<span class="badge ${color} stage">${esc(label)}</span>`;
}

function typeLabel(type) {
  return TYPE_LABELS[type] || "Request";
}

function attachmentCount(req) {
  const list = Array.isArray(req && req.attachments) ? req.attachments : [];
  return list.length;
}

// "YYYY-MM-DD" -> "Fri, Jun 20" (locale-friendly, no time zone surprises).
function formatDate(iso) {
  if (!iso || typeof iso !== "string") return "";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

// "19:30" -> "7:30 PM" (locale-friendly). Empty/invalid -> "".
function formatTime(t) {
  if (!t || !/^\d{1,2}:\d{2}$/.test(String(t))) return "";
  const [h, m] = String(t).split(":").map(Number);
  if (h > 23 || m > 59) return "";
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// Swap any raw 24-hour times inside prose (e.g. "at 19:30") for the 12-hour form
// a client would actually write ("at 7:30 PM"). Used on idea prefills.
function humanizeTimes(text) {
  return String(text || "").replace(/\b(\d{1,2}):(\d{2})\b/g, (match, h, m) => formatTime(`${h}:${m}`) || match);
}

// Relative timestamp for thread messages.
function msgWhen(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const mins = Math.round((Date.now() - t) / 60000), hrs = Math.round(mins / 60), days = Math.round(hrs / 24);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (hrs < 24) return `${hrs} hr ago`;
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// The per-request conversation thread (client perspective: client = "You").
function threadHtml(req) {
  const thread = (req && req.meta && Array.isArray(req.meta.thread)) ? req.meta.thread : [];
  const msgs = thread.map((m) => {
    const mine = m.from === "client";
    return `<div class="msg ${mine ? "mine" : "theirs"}">
        <div class="msg-bubble">${esc(m.text)}</div>
        <div class="msg-meta">${mine ? "You" : "NYNM"} · ${esc(msgWhen(m.at))}</div>
      </div>`;
  }).join("");
  return `
    <div class="thread">
      <div class="thread-label">${thread.length ? "Conversation" : "Add a note for the team"}</div>
      ${thread.length ? `<div class="thread-list">${msgs}</div>` : ""}
      <div class="thread-reply">
        <textarea class="thread-input" data-msg-id="${esc(req.id)}" rows="1" placeholder="Message your team"></textarea>
        <button type="button" class="btn sm" data-msg-send="${esc(req.id)}">Send</button>
      </div>
    </div>`;
}

function sortByCreatedDesc(a, b) {
  return String(b && b.createdAt || "").localeCompare(String(a && a.createdAt || ""));
}

// Soonest first; undated events sink to the end instead of floating to the top.
function sortByDateAsc(a, b) {
  const da = String(a && a.date || "");
  const db = String(b && b.date || "");
  if (!da && !db) return 0;
  if (!da) return 1;
  if (!db) return -1;
  return da.localeCompare(db);
}

// Local "today" as YYYY-MM-DD (no UTC surprises), for the past-event filter.
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* ---------- rendering: lists ---------- */

// Snapshot half-typed thread drafts (and which one has the keyboard) so a
// background re-render never eats what the client is typing.
function snapshotThreadDrafts() {
  const drafts = {};
  requestsList.querySelectorAll(".thread-input").forEach((ta) => {
    const id = ta.getAttribute("data-msg-id");
    if (id && ta.value) drafts[id] = ta.value;
  });
  const active = document.activeElement;
  const focused = (active && active.classList && active.classList.contains("thread-input"))
    ? { id: active.getAttribute("data-msg-id"), start: active.selectionStart, end: active.selectionEnd }
    : null;
  return { drafts, focused };
}

function restoreThreadDrafts({ drafts, focused }) {
  for (const [id, value] of Object.entries(drafts)) {
    const ta = requestsList.querySelector(`[data-msg-id="${CSS.escape(id)}"]`);
    if (ta) ta.value = value;
  }
  if (focused && focused.id) {
    const ta = requestsList.querySelector(`[data-msg-id="${CSS.escape(focused.id)}"]`);
    if (ta) {
      ta.focus();
      try { ta.setSelectionRange(focused.start, focused.end); } catch { /* non-fatal */ }
    }
  }
}

function renderRequests(requests) {
  const list = Array.isArray(requests) ? requests.slice() : [];
  list.sort(sortByCreatedDesc);

  if (list.length === 0) {
    requestsList.innerHTML =
      `<div class="card"><div class="empty">No requests yet. Send your first one above.</div></div>`;
    return;
  }

  const typing = snapshotThreadDrafts();

  requestsList.innerHTML = list.map((req) => {
    const title = (req && req.title) ? esc(req.title) : esc(typeLabel(req && req.type));
    const desc = (req && req.description) ? esc(req.description) : "";
    const count = attachmentCount(req);
    const photoMeta = count > 0
      ? `<span class="muted small">${count} photo${count === 1 ? "" : "s"}</span>`
      : "";
    const descRow = desc ? `<div class="req-desc">${desc}</div>` : "";

    return `
      <div class="card">
        <div class="req">
          <div class="req-main">
            <div class="req-title">${title}</div>
            ${descRow}
            <div class="req-meta">
              <span class="badge bone">${esc(typeLabel(req && req.type))}</span>
              ${photoMeta}
            </div>
          </div>
          ${stageBadge(req && req.stage, req && req.type)}
        </div>
        ${threadHtml(req)}
      </div>`;
  }).join("");

  restoreThreadDrafts(typing);
}

function renderEvents(events) {
  const today = todayISO();
  // Past events drop out of "Upcoming events" (undated ones stay, sorted last).
  const list = (Array.isArray(events) ? events.slice() : []).filter((evt) => {
    const date = String(evt && evt.date || "").slice(0, 10);
    return !date || date >= today;
  });
  list.sort(sortByDateAsc);

  if (list.length === 0) {
    eventsList.innerHTML =
      `<div class="card"><div class="empty">Nothing scheduled yet. Add an event to plan ahead.</div></div>`;
    return;
  }

  eventsList.innerHTML = list.map((evt) => {
    const title = esc((evt && evt.title) || "Event");
    const date = formatDate(evt && evt.date);
    const time = formatTime(evt && evt.time);
    const endTime = formatTime(evt && evt.endTime);
    const timeText = time ? (endTime ? `${time} – ${endTime}` : time) : "";
    const when = date ? `${date}${timeText ? ` at ${timeText}` : ""}` : "";
    const desc = (evt && evt.description) ? esc(evt.description) : "";
    return `
      <div class="card">
        <div class="evt">
          <div class="evt-title">${title}</div>
          ${when ? `<div class="evt-date">${esc(when)}</div>` : ""}
          ${desc ? `<div class="evt-desc">${desc}</div>` : ""}
        </div>
      </div>`;
  }).join("");
}

/* ---------- rendering: proactive ideas ---------- */

function renderIdeas(data) {
  currentIdeas = computeIdeas(data || {}, new Date());
  if (!currentIdeas.length) {
    ideasSection.classList.add("hidden");
    ideasList.innerHTML = "";
    return;
  }
  ideasSection.classList.remove("hidden");
  ideasList.innerHTML = currentIdeas.map((idea, i) => `
    <div class="card idea-card">
      <div class="idea-title">${esc(idea.title)}</div>
      <div class="idea-detail">${esc(idea.detail)}</div>
      <div class="idea-actions">
        <button type="button" class="btn sm primary" data-idea="${i}" data-act="use">Use this idea</button>
        ${idea.campaign ? `<button type="button" class="btn sm" data-idea="${i}" data-act="campaign">Build the campaign</button>` : ""}
      </div>
    </div>`).join("");
}

/* ================================================================
   FOOD TRUCKS
   Month calendar -> day detail -> add/edit/remove truck bookings.
   Optimistic local paint + reconcile on next load(), mirroring addEvent.
   ================================================================ */

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

// "09:00" -> "9A", "17:00" -> "5P", "12:30" -> "12:30P" (compact, spec §5 "9A–5P").
function compactTime(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ""));
  if (!m) return "";
  let h = Number(m[1]);
  const min = m[2];
  const ap = h >= 12 ? "P" : "A";
  h = h % 12 || 12;
  return min === "00" ? `${h}${ap}` : `${h}:${min}${ap}`;
}
// "09:00"/"17:00" -> "9A–5P"
function hoursLabel(start, end) {
  const s = compactTime(start), e = compactTime(end);
  if (!s && !e) return "";
  return e ? `${s}–${e}` : s;
}

// Local YYYY-MM-DD for a given y/m(0-based)/d (no UTC drift).
function ymd(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// Scheduled bookings for this client (defensive: server already filters cancelled).
function activeBookings() {
  const list = (currentData && Array.isArray(currentData.bookings)) ? currentData.bookings : [];
  return list.filter((b) => b && b.status !== "cancelled");
}
function vendorsList() {
  const list = (currentData && Array.isArray(currentData.vendors)) ? currentData.vendors : [];
  return list.filter((v) => v && v.active !== false);
}
// Bookings on a given date, name-sorted so the day reads consistently.
function bookingsOn(dateISO) {
  return activeBookings()
    .filter((b) => String(b.date) === dateISO)
    .sort((a, b) => String(a.vendorName || "").localeCompare(String(b.vendorName || ""))
      || String(a.startTime || "").localeCompare(String(b.startTime || "")));
}

/* ---------- surface switch (Requests | Food Trucks) ---------- */

function selectSurface(surface) {
  currentSurface = surface === "trucks" && foodTrucksEnabled ? "trucks" : "requests";
  const btns = Array.from(surfaceChips.querySelectorAll(".seg-btn"));
  let idx = 0;
  btns.forEach((btn, i) => {
    const active = btn.dataset.surface === currentSurface;
    btn.setAttribute("aria-selected", active ? "true" : "false");
    if (active) idx = i;
  });
  const thumb = surfaceChips.querySelector(".seg-thumb");
  if (thumb && btns.length) {
    thumb.style.width = `calc((100% - 4px) / ${btns.length})`;
    thumb.style.transform = `translateX(${idx * 100}%)`;
  }
  surfaceRequests.classList.toggle("hidden", currentSurface !== "requests");
  surfaceTrucks.classList.toggle("hidden", currentSurface !== "trucks");
  if (currentSurface === "trucks") renderCalendar();
}

/* ---------- calendar ---------- */

function renderCalendar() {
  if (!calGrid) return;
  const counts = {};
  for (const b of activeBookings()) counts[b.date] = (counts[b.date] || 0) + 1;

  calTitle.textContent = `${MONTH_NAMES[calMonth]} ${calYear}`;

  const firstDow = new Date(calYear, calMonth, 1).getDay();     // 0=Sun
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const today = todayISO();

  let cells = "";
  for (let i = 0; i < firstDow; i++) cells += `<div class="cal-cell blank" role="gridcell" aria-hidden="true"></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = ymd(calYear, calMonth, d);
    const n = counts[iso] || 0;
    const classes = ["cal-cell"];
    if (iso === today) classes.push("today");
    if (n > 0) classes.push("has-bookings");
    if (iso === selectedDate) classes.push("selected");
    const badge = n > 0 ? `<span class="cal-count">${n}</span>` : "";
    const aria = `${formatDate(iso)}${n ? `, ${n} truck${n === 1 ? "" : "s"}` : ", no trucks"}`;
    cells += `<button type="button" class="${classes.join(" ")}" role="gridcell"
        data-date="${iso}" aria-label="${esc(aria)}"${iso === selectedDate ? ' aria-selected="true"' : ""}>
        <span class="cal-num">${d}</span>${badge}
      </button>`;
  }
  calGrid.innerHTML = cells;

  // Keep an open day-detail in sync if we navigated back to its month.
  if (selectedDate) {
    const [sy, sm] = selectedDate.split("-").map(Number);
    if (sy === calYear && sm - 1 === calMonth) renderDayDetail();
    else { selectedDate = ""; dayDetail.classList.add("hidden"); }
  }
}

function stepMonth(delta) {
  calMonth += delta;
  if (calMonth < 0) { calMonth = 11; calYear -= 1; }
  else if (calMonth > 11) { calMonth = 0; calYear += 1; }
  renderCalendar();
}

/* ---------- day detail ---------- */

function openDay(dateISO) {
  selectedDate = dateISO;
  hideResults();
  newTruckForm.classList.add("hidden");
  truckSearch.value = "";
  renderCalendar();               // repaint selection highlight
  dayDetail.classList.remove("hidden");
  renderDayDetail();
  dayDetail.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderDayDetail() {
  if (!selectedDate) return;
  dayDetailLabel.textContent = formatDate(selectedDate);
  const list = bookingsOn(selectedDate);
  if (list.length === 0) {
    dayTrucks.innerHTML = `<div class="card"><div class="empty">No trucks booked yet. Add one below.</div></div>`;
    return;
  }
  dayTrucks.innerHTML = `<div class="card">${list.map((b) => {
    const hours = hoursLabel(b.startTime, b.endTime);
    const cat = b.vendorCategory || vendorCategoryFor(b.vendorId);
    return `
      <div class="truck-row" data-booking="${esc(b.id)}">
        <div class="truck-main">
          <div class="truck-name">${esc(b.vendorName || "Truck")}</div>
          <div class="truck-meta">
            ${hours ? `<span class="truck-hours">${esc(hours)}</span>` : ""}
            ${cat ? `<span class="badge bone">${esc(cat)}</span>` : ""}
          </div>
          ${b.note ? `<div class="truck-note">${esc(b.note)}</div>` : ""}
        </div>
        <div class="truck-actions">
          <button type="button" class="icon-btn" data-edit-booking="${esc(b.id)}" aria-label="Edit time or note">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20 L4 16 L15 5 L19 9 L8 20 Z" /><path d="M13 7 L17 11" /></svg>
          </button>
          <button type="button" class="icon-btn danger" data-remove-booking="${esc(b.id)}" aria-label="Remove ${esc(b.vendorName || "truck")}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6 L18 18 M18 6 L6 18" /></svg>
          </button>
        </div>
      </div>`;
  }).join("")}</div>`;
}

function vendorCategoryFor(vendorId) {
  const v = vendorsList().find((x) => x.id === vendorId);
  return v ? v.category : "";
}

/* ---------- add-a-truck search ---------- */

function hideResults() {
  truckResults.classList.add("hidden");
  truckResults.innerHTML = "";
  truckSearch.setAttribute("aria-expanded", "false");
}

function renderResults(query) {
  const q = query.trim().toLowerCase();
  const matches = vendorsList()
    .filter((v) => !q || String(v.name || "").toLowerCase().includes(q) || String(v.category || "").toLowerCase().includes(q))
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")))
    .slice(0, 8);

  const rows = matches.map((v) => `
    <button type="button" class="truck-result" role="option" data-vendor="${esc(v.id)}">
      <span class="tr-name">${esc(v.name)}</span>
      <span class="tr-cat">${esc(v.category || "")}</span>
    </button>`).join("");

  const addNew = `
    <button type="button" class="truck-result add-new" role="option" data-add-new="1">
      <span class="tr-name">+ Add a new truck${q ? ` "${esc(query.trim())}"` : ""}</span>
    </button>`;

  truckResults.innerHTML = rows + addNew;
  truckResults.classList.remove("hidden");
  truckSearch.setAttribute("aria-expanded", "true");
}

/* ---------- booking editor sheet ---------- */

function openBookingSheet(ctx) {
  sheetCtx = ctx;
  bkError.classList.add("hidden");
  bkError.textContent = "";
  if (ctx.mode === "add") {
    const v = vendorsList().find((x) => x.id === ctx.vendorId);
    bkSheetTitle.textContent = v ? v.name : "Truck";
    bkSheetWhen.textContent = formatDate(selectedDate);
    bkStart.value = "09:00";
    bkEnd.value = "17:00";
    bkNote.value = "";
    bkRepeat.checked = false;
    bkRepeatRow.classList.remove("hidden");
    bkSave.textContent = "Book it";
  } else {
    const b = activeBookings().find((x) => x.id === ctx.id);
    if (!b) return;
    bkSheetTitle.textContent = b.vendorName || "Truck";
    bkSheetWhen.textContent = formatDate(b.date);
    bkStart.value = b.startTime || "09:00";
    bkEnd.value = b.endTime || "17:00";
    bkNote.value = b.note || "";
    bkRepeatRow.classList.add("hidden");
    bkSave.textContent = "Save";
  }
  bookingSheet.classList.remove("hidden");
  setTimeout(() => bkStart && bkStart.focus(), 60);
}

function closeBookingSheet() {
  bookingSheet.classList.add("hidden");
  sheetCtx = null;
}

// Every same-weekday date from `fromISO` through the end of its month (inclusive).
function weeklyDatesThroughMonthEnd(fromISO) {
  const [y, m, d] = fromISO.split("-").map(Number);
  const daysInMonth = new Date(y, m, 0).getDate(); // m is 1-based here -> day 0 of next month
  const out = [];
  for (let day = d; day <= daysInMonth; day += 7) out.push(ymd(y, m - 1, day));
  return out;
}

function newSeriesId() {
  return (window.crypto && crypto.randomUUID) ? `ser_${crypto.randomUUID()}` : `ser_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

/* ---------- rendering: attachment thumbnails ---------- */

function renderThumbs() {
  if (pendingAttachments.length === 0) {
    thumbsEl.classList.add("hidden");
    thumbsEl.innerHTML = "";
    return;
  }
  thumbsEl.classList.remove("hidden");
  thumbsEl.innerHTML = pendingAttachments.map((a, i) => {
    const removeBtn = `<button type="button" class="thumb-remove" data-remove="${i}" aria-label="Remove ${esc(a.name || "photo")}">&times;</button>`;
    const mime = a.mime || "";
    if (mime.startsWith("audio/")) {
      return `<div class="thumb thumb-audio" title="${esc(a.name || "voice note")}"><span class="small">voice</span>${removeBtn}</div>`;
    }
    const isImage = mime.startsWith("image/") && a.url;
    const inner = isImage
      ? `<img class="zoomable" src="${esc(a.url)}" alt="${esc(a.name || "attachment")}" />`
      : `<span class="small">file</span>`;
    return `<div class="thumb" title="${esc(a.name || "")}">${inner}${removeBtn}</div>`;
  }).join("");
}

/* ---------- type selection ---------- */

function selectType(type) {
  selectedType = type;

  // Update the segmented control: aria-selected per segment + slide the white thumb.
  const btns = Array.from(typeChips.querySelectorAll(".seg-btn"));
  let idx = 0;
  btns.forEach((btn, i) => {
    const active = btn.dataset.type === type;
    btn.setAttribute("aria-selected", active ? "true" : "false");
    if (active) idx = i;
  });
  const thumb = typeChips.querySelector(".seg-thumb");
  if (thumb && btns.length) {
    thumb.style.width = `calc((100% - 4px) / ${btns.length})`;
    thumb.style.transform = `translateX(${idx * 100}%)`;
  }

  const isEvent = type === "event";
  requestForm.classList.toggle("hidden", isEvent);
  eventForm.classList.toggle("hidden", !isEvent);

  if (!isEvent) {
    const hint = DESC_HINTS[type] || DESC_HINTS.post;
    reqDescLabel.textContent = hint.label;
    reqDesc.placeholder = hint.placeholder;
  }
}

/* ---------- form reset ---------- */

function resetRequestForm() {
  reqDesc.value = "";
  reqFiles.value = "";
  reqCamera.value = "";
  pendingAttachments = [];
  uploadingCount = 0;
  uploadStatus.textContent = "";
  renderThumbs();
}

function resetEventForm() {
  evtTitle.value = "";
  evtDate.value = "";
  evtTime.value = "";
  evtEndTime.value = "";
  evtDesc.value = "";
}

/* ---------- upload on selection ---------- */

async function onFilesPicked(inputEl) {
  const src = inputEl || reqFiles;
  const files = Array.from(src.files || []);
  if (files.length === 0) return;
  src.value = ""; // allow re-picking the same file later
  for (const file of files) await uploadOne(file);
}

// Upload one File (photo, camera shot, or recorded voice note); track as a pending attachment.
async function uploadOne(file) {
  uploadingCount += 1;
  updateUploadStatus();
  try {
    const payload = await fileToPayload(file);
    // Defense-in-depth: even after compression, refuse a file the backend would reject
    // (matches the ~7MB server cap) so the person gets a clear message, not a silent fail.
    if ((payload.dataBase64 || "").length > 10000000) {
      toast(`"${file.name || "That photo"}" is too large to upload — try a smaller one.`);
      return;
    }
    const res = await api.upload(payload);
    if (res && res.ok && res.url) {
      pendingAttachments.push({ name: res.name || file.name, url: res.url, mime: res.mime || file.type || "" });
      renderThumbs();
    } else {
      toast(`Couldn't upload "${file.name || "that photo"}" — try again.`);
    }
  } catch (err) {
    toast(`Couldn't upload "${file.name || "that photo"}" — try again.`);
  } finally {
    uploadingCount = Math.max(0, uploadingCount - 1);
    updateUploadStatus();
  }
}

function updateUploadStatus() {
  if (uploadingCount > 0) {
    uploadStatus.textContent = `Uploading ${uploadingCount}…`;
  } else if (pendingAttachments.length > 0) {
    const n = pendingAttachments.length;
    uploadStatus.textContent = `${n} photo${n === 1 ? "" : "s"} attached`;
  } else {
    uploadStatus.textContent = "";
  }
}

/* ---------- submit request ---------- */

// Stable id for one logical submission; reused across flaky-network retries so the
// backend dedupes, cleared on success. Prevents duplicate requests on mobile.
let pendingSubmitId = null;

async function submitRequest(event) {
  event.preventDefault();
  if (busy) return;

  let description = reqDesc.value.trim();
  if (!description && pendingAttachments.length === 0) {
    toast("Add a short note or a photo so we know what you need.");
    reqDesc.focus();
    return;
  }
  if (uploadingCount > 0) {
    toast("Hang on, an upload is still finishing.");
    return;
  }
  if (!description) description = "Please post this.";

  setBusy(true, reqSubmit, "Sending…");
  try {
    if (!pendingSubmitId) pendingSubmitId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : `c_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const res = await api.submit({
      type: selectedType,
      title: "",
      description,
      attachments: pendingAttachments.slice(),
    }, pendingSubmitId);
    if (res && res.ok) {
      pendingSubmitId = null;
      // Paint the new request card immediately; the background refresh reconciles.
      addLocalRequest({
        id: res.id || `local_${Date.now()}`,
        type: selectedType,
        title: "",
        description,
        attachments: pendingAttachments.slice(),
        stage: "submitted",
        createdAt: new Date().toISOString(),
        meta: {},
      });
      resetRequestForm();
      toast("Request sent. We'll take it from here.");
      refresh(); // deliberately not awaited — the button unlocks right away
    } else {
      toast("That didn't send. Please try again.");
    }
  } catch (err) {
    toast("That didn't send. Please try again.");
  } finally {
    setBusy(false, reqSubmit, "Submit request");
  }
}

/* ---------- add event ---------- */

async function submitEvent(event) {
  event.preventDefault();
  if (busy) return;

  const title = evtTitle.value.trim();
  const date = evtDate.value.trim();
  if (!title) {
    toast("Give the event a name.");
    evtTitle.focus();
    return;
  }
  if (!date) {
    toast("Pick a date for the event.");
    evtDate.focus();
    return;
  }

  setBusy(true, evtSubmit, "Adding…");
  try {
    const res = await api.addEvent({
      title,
      date,
      time: evtTime.value.trim(),
      endTime: evtEndTime.value.trim(),
      description: evtDesc.value.trim(),
    });
    if (res && res.ok) {
      // Paint the new event immediately; the background refresh reconciles.
      addLocalEvent({
        eventId: res.eventId || `local_${Date.now()}`,
        title,
        date,
        time: evtTime.value.trim(),
        endTime: evtEndTime.value.trim(),
        description: evtDesc.value.trim(),
      });
      resetEventForm();
      toast("Event added to your calendar.");
      refresh(); // deliberately not awaited — the button unlocks right away
    } else {
      toast("That didn't save. Please try again.");
    }
  } catch (err) {
    toast("That didn't save. Please try again.");
  } finally {
    setBusy(false, evtSubmit, "Add to calendar");
  }
}

function setBusy(value, button, label) {
  busy = value;
  if (button) {
    button.disabled = value;
    button.textContent = label;
  }
}

/* ---------- food trucks: submit booking (add or edit) ---------- */

async function submitBooking(event) {
  event.preventDefault();
  if (busy || !sheetCtx) return;

  const start = bkStart.value.trim() || "09:00";
  const end = bkEnd.value.trim() || "17:00";
  if (end < start) {
    bkError.textContent = "End time can't be before the start time.";
    bkError.classList.remove("hidden");
    return;
  }
  bkError.classList.add("hidden");
  const note = bkNote.value.trim();

  // ---- EDIT: patch time/note on one booking ----
  if (sheetCtx.mode === "edit") {
    const id = sheetCtx.id;
    setBusy(true, bkSave, "Saving…");
    try {
      const res = await api.updateBooking(id, { startTime: start, endTime: end, note });
      if (res && res.ok) {
        updateLocalBooking(id, { startTime: start, endTime: end, note });
        closeBookingSheet();
        renderDayDetail();
        toast("Updated.");
        refresh();
      } else {
        bkError.textContent = "That didn't save. Please try again.";
        bkError.classList.remove("hidden");
      }
    } catch (err) {
      bkError.textContent = "That didn't save. Please try again.";
      bkError.classList.remove("hidden");
    } finally {
      setBusy(false, bkSave, "Save");
    }
    return;
  }

  // ---- ADD: one booking, or a weekly series through month-end ----
  const vendor = vendorsList().find((v) => v.id === sheetCtx.vendorId);
  if (!vendor) { closeBookingSheet(); return; }
  const dates = bkRepeat.checked ? weeklyDatesThroughMonthEnd(selectedDate) : [selectedDate];
  const seriesId = bkRepeat.checked && dates.length > 1 ? newSeriesId() : "";
  const bookings = dates.map((date) => ({ vendorId: vendor.id, date, startTime: start, endTime: end, note }));

  setBusy(true, bkSave, "Booking…");
  try {
    const res = await api.addBookings(bookings, seriesId);
    if (res && res.ok) {
      // Paint the new bookings immediately using the ids the server returned.
      const ids = Array.isArray(res.ids) ? res.ids : [];
      const nowIso = new Date().toISOString();
      const local = bookings.map((b, i) => ({
        id: ids[i] || `local_${Date.now()}_${i}`,
        clientId: (currentData && currentData.client && currentData.client.clientId) || "",
        vendorId: b.vendorId,
        vendorName: vendor.name,
        vendorCategory: vendor.category,
        date: b.date,
        startTime: b.startTime,
        endTime: b.endTime,
        note: b.note,
        seriesId,
        status: "scheduled",
        createdAt: nowIso,
        updatedAt: nowIso,
      }));
      addLocalBookings(local);
      closeBookingSheet();
      hideResults();
      truckSearch.value = "";
      renderDayDetail();
      toast(dates.length > 1 ? `Booked ${vendor.name} on ${dates.length} days.` : `${vendor.name} booked.`);
      refresh();
    } else {
      bkError.textContent = "That didn't book. Please try again.";
      bkError.classList.remove("hidden");
    }
  } catch (err) {
    bkError.textContent = "That didn't book. Please try again.";
    bkError.classList.remove("hidden");
  } finally {
    setBusy(false, bkSave, "Book it");
  }
}

/* ---------- food trucks: add a brand-new truck, then book it ---------- */

async function submitNewTruck(event) {
  event.preventDefault();
  if (busy) return;

  const name = ntName.value.trim();
  const category = ntCategory.value.trim().toUpperCase();
  const price = ntPrice.value;
  const tagline = ntTagline.value.trim();
  if (!name) { toast("Give the truck a name."); ntName.focus(); return; }
  if (!category) { toast("Pick or type a category."); ntCategory.focus(); return; }

  const ntSave = $("nt-save");
  setBusy(true, ntSave, "Adding…");
  try {
    const res = await api.upsertVendor({ name, category, price, tagline, active: true });
    if (res && res.ok && res.vendorId) {
      const nowIso = new Date().toISOString();
      addLocalVendor({
        id: res.vendorId,
        clientId: (currentData && currentData.client && currentData.client.clientId) || "",
        name, category, price, tagline, active: true,
        createdAt: nowIso, updatedAt: nowIso,
      });
      newTruckForm.classList.add("hidden");
      ntName.value = ""; ntCategory.value = ""; ntTagline.value = ""; ntPrice.value = "$$";
      // Immediately open the booking sheet for the truck we just created.
      openBookingSheet({ mode: "add", vendorId: res.vendorId });
      refresh();
    } else {
      toast("Couldn't add that truck. Please try again.");
    }
  } catch (err) {
    toast("Couldn't add that truck. Please try again.");
  } finally {
    setBusy(false, ntSave, "Add & book it");
  }
}

async function removeBooking(id) {
  const b = activeBookings().find((x) => x.id === id);
  const name = (b && b.vendorName) || "this truck";
  if (!window.confirm(`Remove ${name} from ${formatDate(selectedDate)}?`)) return;
  // Optimistic: drop it now, restore on failure.
  removeLocalBooking(id);
  renderDayDetail();
  try {
    const res = await api.deleteBooking({ id });
    if (res && res.ok) { toast("Removed."); refresh(); }
    else { toast("Couldn't remove that. Refreshing…"); refresh(); }
  } catch (err) {
    toast("Couldn't remove that. Refreshing…");
    refresh();
  }
}

/* ---------- load / refresh ---------- */

// Signature of the render-relevant slice of a payload. Lets applyData skip the
// wholesale innerHTML rebuild when a background revalidation returns the exact
// same data (so half-typed drafts and scroll position are never disturbed).
function dataSig(data) {
  try {
    return JSON.stringify([data && data.client, data && data.requests, data && data.events,
      data && data.vendors, data && data.bookings]);
  } catch {
    return `sig_${Date.now()}`;
  }
}

function applyData(data) {
  currentData = data;
  const sig = dataSig(data);
  if (sig === lastRenderSig) return;
  lastRenderSig = sig;

  const client = (data && data.client) || {};
  const name = client.name || "Your business";
  clientNameEl.textContent = name;

  // Show the brand logo above the title when we have one for this client.
  if (brandLogoEl) {
    const logoSrc = BRAND_LOGOS[client.brandSlug] || BRAND_LOGOS[client.clientId] || "";
    if (logoSrc) {
      brandLogoEl.src = logoSrc;
      brandLogoEl.alt = name;
      brandLogoEl.classList.remove("hidden");
    }
  }

  document.querySelector(".large-title")?.classList.remove("hidden");
  document.title = `${name} · Relay`;
  renderRequests(data && data.requests);
  renderEvents(data && data.events);
  renderIdeas(data);
  applyFoodTrucks(data);
}

/* ---------- food trucks: gating + surface sync ---------- */

// The Food Trucks surface exists when the payload flags the feature, OR the client
// is in the allowlist below. The production Sheet backend has no `features` column,
// so the stored flag can't round-trip — the allowlist is the reliable prod gate.
const FOOD_TRUCK_CLIENT_IDS = new Set(["eats-on-601"]);
function applyFoodTrucks(data) {
  const client = (data && data.client) || {};
  const enabled = !!(client.features && client.features.foodTrucks === true) || FOOD_TRUCK_CLIENT_IDS.has(client.clientId);
  foodTrucksEnabled = enabled;

  if (!enabled) {
    surfaceChips.classList.add("hidden");
    surfaceTrucks.classList.add("hidden");
    surfaceRequests.classList.remove("hidden");
    currentSurface = "requests";
    return;
  }

  surfaceChips.classList.remove("hidden");

  // First time we learn the feature is on: default the calendar to the current month.
  if (!calYear) {
    const now = new Date();
    calYear = now.getFullYear();
    calMonth = now.getMonth();
  }

  // Category datalist for "+ Add a new truck", built from the vendors already present
  // (uppercased, deduped) — constrains to the known set while still allowing a new one.
  const cats = [...new Set(vendorsList().map((v) => String(v.category || "").toUpperCase()).filter(Boolean))].sort();
  truckCategories.innerHTML = cats.map((c) => `<option value="${esc(c)}"></option>`).join("");

  // If the trucks surface is showing, repaint it against the fresh data.
  if (currentSurface === "trucks") renderCalendar();
}

// Re-fetch the client's data and re-render the lists (used after submits and
// on revalidate). Writes the fresh payload through to the on-device cache so a
// closed-and-reopened app paints the latest data, not a pre-submit snapshot.
async function refresh() {
  try {
    const res = await api.load();
    if (res && res.ok) {
      if (DATA_CACHE_KEY) writeDataCache(safeLocalStorage(), DATA_CACHE_KEY, res);
      lastLoadedAt = Date.now();
      applyData(res);
    }
  } catch (err) {
    /* keep the current view; a transient refresh failure shouldn't blank the screen */
  }
}

/* ---------- optimistic local updates (instant UI, server reconciles after) ---------- */

// Merge a locally-known change into the current payload, re-render, and write it
// through to the cache so a reopened app includes it immediately.
function applyLocalData(next) {
  if (DATA_CACHE_KEY) writeDataCache(safeLocalStorage(), DATA_CACHE_KEY, next);
  applyData(next);
}

// A just-submitted request, painted before the background refresh confirms it.
function addLocalRequest(req) {
  const data = currentData || { ok: true, client: {}, requests: [], events: [] };
  const requests = Array.isArray(data.requests) ? data.requests.slice() : [];
  if (!requests.some((r) => r && r.id === req.id)) requests.unshift(req);
  applyLocalData({ ...data, requests });
}

// A just-added event.
function addLocalEvent(evt) {
  const data = currentData || { ok: true, client: {}, requests: [], events: [] };
  const events = Array.isArray(data.events) ? data.events.slice() : [];
  if (!events.some((e) => e && e.eventId === evt.eventId)) events.push(evt);
  applyLocalData({ ...data, events });
}

/* ---------- optimistic local updates: food trucks ---------- */

// Merge locally-known vendors/bookings, re-render calendar + open day, cache through.
function applyLocalTrucks({ vendors, bookings }) {
  const data = currentData || { ok: true, client: {}, requests: [], events: [], vendors: [], bookings: [] };
  const next = {
    ...data,
    vendors: vendors || data.vendors || [],
    bookings: bookings || data.bookings || [],
  };
  // applyData short-circuits when the requests/events/client signature is unchanged
  // (food-truck edits don't touch those), so paint the trucks surface directly.
  currentData = next;
  if (DATA_CACHE_KEY) writeDataCache(safeLocalStorage(), DATA_CACHE_KEY, next);
  if (currentSurface === "trucks") renderCalendar();
}

function addLocalVendor(vendor) {
  const data = currentData || {};
  const vendors = Array.isArray(data.vendors) ? data.vendors.slice() : [];
  const idx = vendors.findIndex((v) => v && v.id === vendor.id);
  if (idx >= 0) vendors[idx] = { ...vendors[idx], ...vendor };
  else vendors.push(vendor);
  applyLocalTrucks({ vendors });
}

function addLocalBookings(bookings) {
  const data = currentData || {};
  const list = Array.isArray(data.bookings) ? data.bookings.slice() : [];
  for (const b of bookings) if (!list.some((x) => x && x.id === b.id)) list.push(b);
  applyLocalTrucks({ bookings: list });
}

function updateLocalBooking(id, patch) {
  const data = currentData || {};
  const list = Array.isArray(data.bookings) ? data.bookings.slice() : [];
  const idx = list.findIndex((b) => b && b.id === id);
  if (idx >= 0) { list[idx] = { ...list[idx], ...patch }; applyLocalTrucks({ bookings: list }); }
}

function removeLocalBooking(id) {
  const data = currentData || {};
  const list = (Array.isArray(data.bookings) ? data.bookings : []).filter((b) => b && b.id !== id);
  applyLocalTrucks({ bookings: list });
}

// The server's updated copy of one request (e.g. after posting a thread message).
function updateLocalRequest(req) {
  if (!req || !req.id) return;
  const data = currentData || { ok: true, client: {}, requests: [], events: [] };
  const requests = (Array.isArray(data.requests) ? data.requests.slice() : []);
  const idx = requests.findIndex((r) => r && r.id === req.id);
  if (idx >= 0) requests[idx] = req; else requests.unshift(req);
  applyLocalData({ ...data, requests });
}

async function start() {
  // Instant paint: if we've loaded this client before, show their cached data
  // immediately instead of a multi-second blank while Apps Script cold-starts.
  const cached = DATA_CACHE_KEY ? readDataCache(safeLocalStorage(), DATA_CACHE_KEY) : null;
  const painted = !!(cached && cached.ok && cached.client);
  if (painted) {
    applyData(cached);
    showView("app");
  } else {
    showView("loading");
  }

  // Revalidate against the server in the background (and on first-ever open).
  let res;
  try {
    res = await api.load();
  } catch (err) {
    // Network blip, not a bad link: keep showing cached data, or offer a retry.
    if (!painted) showView("offline");
    return;
  }

  // Needs a PIN as a second factor (authoritative — override any cached view).
  if (res && res.status === 401 && res.needPin) {
    showView("pin");
    setTimeout(() => $("pin-input") && $("pin-input").focus(), 50);
    return;
  }

  // A definitive 403 means the token itself was rejected — that (and only that)
  // earns the invalid-link screen. If we have cached data, keep the client on
  // their data instead of flashing a scary "invalid link" screen.
  if (res && res.status === 403) {
    if (!painted) showView("badlink");
    return;
  }

  // Anything else that isn't a clean payload (5xx, malformed body) is a server
  // problem, not the client's link — show the friendly retry state.
  if (!res || !res.ok) {
    if (!painted) showView("offline");
    return;
  }

  // Good — persist token, cache the fresh payload, and reconcile the view.
  rememberAccess();
  if (DATA_CACHE_KEY) writeDataCache(safeLocalStorage(), DATA_CACHE_KEY, res);
  lastLoadedAt = Date.now();
  applyData(res);
  showView("app");
}

/* ---------- PIN flow ---------- */

async function onPinSubmit(event) {
  event.preventDefault();
  const input = $("pin-input");
  const errorEl = $("pin-error");
  const value = (input.value || "").trim();
  if (!value) {
    input.focus();
    return;
  }

  pin = value;
  api = portalApi(token, pin);

  const btn = $("pin-submit");
  btn.disabled = true;
  btn.textContent = "Checking…";

  let res;
  try {
    res = await api.load();
  } catch (err) {
    res = null;
  }

  btn.disabled = false;
  btn.textContent = "Open portal";

  if (res && res.ok) {
    rememberAccess();
    if (DATA_CACHE_KEY) writeDataCache(safeLocalStorage(), DATA_CACHE_KEY, res);
    lastLoadedAt = Date.now();
    errorEl.classList.add("hidden");
    applyData(res);
    showView("app");
    return;
  }

  // Network dropped mid-check: the link and PIN are fine — say so and let them retry.
  if (!res) {
    errorEl.textContent = "Can't reach the server. Check your connection and try again.";
    errorEl.classList.remove("hidden");
    return;
  }

  // Still needs PIN (wrong one) or unauthorized -> show inline error, stay on PIN.
  if (res.needPin || res.status === 401) {
    errorEl.textContent = "That PIN didn't work. Try again.";
    errorEl.classList.remove("hidden");
    input.value = "";
    input.focus();
    // reset api back to base token so a fresh attempt re-prompts cleanly
    api = portalApi(token, pin);
    return;
  }

  // A definitive token rejection -> the link really is bad.
  if (res.status === 403) {
    showView("badlink");
    return;
  }

  // Anything else (server hiccup) -> keep them here with a retry-friendly note.
  errorEl.textContent = "Something went wrong on our end. Give it another try.";
  errorEl.classList.remove("hidden");
}

/* ---------- wire up ---------- */

typeChips.addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (btn && btn.dataset.type) selectType(btn.dataset.type);
});
// Arrow-key navigation for the segmented control (role=tablist).
typeChips.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  const btns = Array.from(typeChips.querySelectorAll(".seg-btn"));
  const i = btns.findIndex((b) => b.dataset.type === selectedType);
  const ni = e.key === "ArrowRight" ? Math.min(btns.length - 1, i + 1) : Math.max(0, i - 1);
  if (ni !== i && btns[ni]) { selectType(btns[ni].dataset.type); btns[ni].focus(); e.preventDefault(); }
});
requestForm.addEventListener("submit", submitRequest);
eventForm.addEventListener("submit", submitEvent);
reqFiles.addEventListener("change", () => onFilesPicked(reqFiles));
reqCamera.addEventListener("change", () => onFilesPicked(reqCamera));
$("view-pin").addEventListener("submit", onPinSubmit);

// "Can't reach the server" retry: run the whole start sequence again.
$("retry-btn")?.addEventListener("click", () => {
  showView("loading");
  start();
});

// Revalidate when the (installed) app comes back to the foreground, so status
// changes and replies show up without a cold relaunch. Throttled to once a minute.
function revalidateOnReturn() {
  if (document.visibilityState !== "visible") return;
  if (!token || busy) return;
  if (!views.app || views.app.classList.contains("hidden")) return;
  if (Date.now() - lastLoadedAt < 60000) return;
  refresh();
}
document.addEventListener("visibilitychange", revalidateOnReturn);
window.addEventListener("focus", revalidateOnReturn);

// Tap the little x to un-attach a photo before sending; tap the preview to zoom.
thumbsEl.addEventListener("click", (e) => {
  const remove = e.target.closest("[data-remove]");
  if (remove) {
    const i = Number(remove.getAttribute("data-remove"));
    if (Number.isInteger(i) && i >= 0 && i < pendingAttachments.length) {
      pendingAttachments.splice(i, 1);
      renderThumbs();
      updateUploadStatus();
    }
    return;
  }
  const img = e.target.closest(".thumb img");
  if (img && img.src) openLightbox(img.src, img.alt || "attachment");
});

// Send a message on a request's thread (delegated — request cards are re-rendered on refresh).
requestsList.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-msg-send]");
  if (!btn) return;
  const id = btn.getAttribute("data-msg-send");
  const ta = requestsList.querySelector(`[data-msg-id="${CSS.escape(id)}"]`);
  const text = ta ? ta.value.trim() : "";
  if (!text) { toast("Type a message first."); if (ta) ta.focus(); return; }
  btn.disabled = true;
  btn.textContent = "Sending…";
  try {
    const res = await api.message(id, text);
    if (res && res.ok) {
      toast("Message sent.");
      if (ta) ta.value = ""; // clear before re-render so the draft snapshot doesn't resurrect it
      // The server returns the updated request — merge it in place instead of a
      // full refetch, so other threads' unsent drafts stay put.
      if (res.request) updateLocalRequest(res.request);
      else refresh();
    } else {
      toast("That didn't send. Please try again.");
      btn.disabled = false;
      btn.textContent = "Send";
    }
  } catch (err) {
    toast("That didn't send. Please try again.");
    btn.disabled = false;
    btn.textContent = "Send";
  }
});

// Proactive ideas: "Use this idea" pre-fills the request form; "Build the campaign" sends the 3-post pack.
ideasList.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-idea]");
  if (!btn) return;
  const idea = currentIdeas[Number(btn.getAttribute("data-idea"))];
  if (!idea) return;
  if (btn.getAttribute("data-act") === "use") {
    selectType(idea.type || "post");
    reqDesc.value = humanizeTimes(idea.postIdea || "");
    requestForm.scrollIntoView({ behavior: "smooth", block: "center" });
    reqDesc.focus();
    toast("Idea added below. Tweak it, then send.");
    return;
  }
  const items = buildCampaign(idea);
  if (!items.length) return;
  if (!window.confirm(`Build the ${idea.label} campaign? This sends ${items.length} post requests (teaser, offer, day-of) to your team.`)) return;
  btn.disabled = true;
  let ok = 0;
  for (const it of items) {
    try { const res = await api.submit(it); if (res && res.ok) ok += 1; } catch (err) { /* keep going */ }
  }
  if (ok === items.length) { toast(`${idea.label} campaign sent. ${ok} posts queued.`); await refresh(); }
  else { toast(`Sent ${ok} of ${items.length}. Please try the rest again.`); btn.disabled = false; }
});

/* ---------- food trucks: wire up ---------- */

// Surface switch (Requests | Food Trucks).
surfaceChips.addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (btn && btn.dataset.surface) selectSurface(btn.dataset.surface);
});
surfaceChips.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  const btns = Array.from(surfaceChips.querySelectorAll(".seg-btn"));
  const i = btns.findIndex((b) => b.dataset.surface === currentSurface);
  const ni = e.key === "ArrowRight" ? Math.min(btns.length - 1, i + 1) : Math.max(0, i - 1);
  if (ni !== i && btns[ni]) { selectSurface(btns[ni].dataset.surface); btns[ni].focus(); e.preventDefault(); }
});

// Month navigation.
calPrev.addEventListener("click", () => stepMonth(-1));
calNext.addEventListener("click", () => stepMonth(1));

// Tap a day cell -> open that day's detail.
calGrid.addEventListener("click", (e) => {
  const cell = e.target.closest("[data-date]");
  if (cell) openDay(cell.getAttribute("data-date"));
});

// Day-detail: edit / remove a booking (delegated — cards re-render on refresh).
dayTrucks.addEventListener("click", (e) => {
  const edit = e.target.closest("[data-edit-booking]");
  if (edit) { openBookingSheet({ mode: "edit", id: edit.getAttribute("data-edit-booking") }); return; }
  const remove = e.target.closest("[data-remove-booking]");
  if (remove) removeBooking(remove.getAttribute("data-remove-booking"));
});

// Add-a-truck search field.
truckSearch.addEventListener("focus", () => { if (foodTrucksEnabled) renderResults(truckSearch.value); });
truckSearch.addEventListener("input", () => renderResults(truckSearch.value));
truckResults.addEventListener("click", (e) => {
  const addNew = e.target.closest("[data-add-new]");
  if (addNew) {
    hideResults();
    // Prefill the new-truck name with whatever they typed.
    ntName.value = truckSearch.value.trim();
    ntCategory.value = ""; ntTagline.value = ""; ntPrice.value = "$$";
    newTruckForm.classList.remove("hidden");
    newTruckForm.scrollIntoView({ behavior: "smooth", block: "center" });
    (ntName.value ? ntCategory : ntName).focus();
    return;
  }
  const pick = e.target.closest("[data-vendor]");
  if (pick) { hideResults(); openBookingSheet({ mode: "add", vendorId: pick.getAttribute("data-vendor") }); }
});
// Dismiss the results dropdown when focus leaves the search area.
document.addEventListener("click", (e) => {
  if (!e.target.closest(".truck-search")) hideResults();
});

// New-truck mini form.
newTruckForm.addEventListener("submit", submitNewTruck);
ntCancel.addEventListener("click", () => {
  newTruckForm.classList.add("hidden");
  ntName.value = ""; ntCategory.value = ""; ntTagline.value = "";
});

// Booking editor sheet.
bookingForm.addEventListener("submit", submitBooking);
bkCancel.addEventListener("click", closeBookingSheet);
bookingSheet.addEventListener("click", (e) => { if (e.target === bookingSheet) closeBookingSheet(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !bookingSheet.classList.contains("hidden")) closeBookingSheet();
});

// Default selection + initial load.
selectType("post");

if (!token) {
  // No ?c= token at all -> can't load anything.
  showView("badlink");
} else {
  start();
}
