// Relay Desk — Marshall's internal control panel for all client requests.
// Plain ES module. Talks to the shared API client (mock locally, Apps Script in prod).
import { deskApi } from "../shared/api.js";
import { API_MODE, API_BASE } from "../shared/config.js";
import { openLightbox, makeZoomable } from "../shared/lightbox.js";
import { resolveAccess, persistAccess, DESK_TOKEN_KEY } from "../shared/token.js";
import { installLaunchManifest } from "../shared/pwa.js";
import { dataCacheKey, readDataCache, writeDataCache } from "../shared/datacache.js";
import { flattenHistory, searchHistory } from "../shared/history.js";

// Trash glyph for the per-request delete control (inline SVG, no icon font / emoji).
const TRASH_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
  '<path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>' +
  '<path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/><path d="M10 11v6M14 11v6"/></svg>';

// Chevron glyph for the expand/collapse affordance on request cards.
const CHEVRON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
  '<path d="M6 9l6 6 6-6"/></svg>';

// Download glyph (down-arrow into a tray) for the attachment "Save" controls.
const DOWNLOAD_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
  '<path d="M12 3v11"/><path d="M8 11l4 4 4-4"/><path d="M5 20h14"/></svg>';

// Document glyph for non-image attachments (PDFs, etc.) that have no thumbnail.
const DOC_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
  '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';

// localStorage, but never throw (private mode / blocked storage).
function safeLocalStorage() {
  try { return window.localStorage; } catch { return null; }
}

// The admin token lives in ?k=… , but an installed home-screen app relaunches
// start_url with no query string. Resolve from the URL first, then durable
// storage, so the installed Desk self-heals instead of dead-ending.
const _access = resolveAccess({
  search: location.search,
  storage: safeLocalStorage(),
  param: "k",
  tokenKey: DESK_TOKEN_KEY,
});
const adminToken = _access.token;
const api = deskApi(adminToken);

// Food-truck writes are tenant-scoped, and for an admin token the backend reads
// the tenant from a TOP-LEVEL `clientId` on the POST body (forcedClientId_ in
// Code.gs / the mock). The shared deskApi.upsertVendor/addBookings don't carry
// one — they're written for the single-tenant portal — so the Desk injects it
// here. Same text/plain + body-status contract as shared/api.js `http()`; we do
// NOT edit that file. updateBooking/deleteBooking match by id with an admin
// bypass, so those keep using the shared client unchanged.
async function adminPost(body) {
  const res = await fetch(API_BASE, {
    method: "POST",
    headers: { "content-type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ admin: adminToken, ...body }),
  });
  let data;
  try { data = await res.json(); } catch { data = { ok: false, error: "bad json from server" }; }
  const status = typeof data.status === "number" ? data.status : res.status;
  return { ...data, status };
}
// Tenant-scoped food-truck admin API: upsertVendor + addBookings need the
// clientId; updateBooking/deleteBooking delegate to the shared client.
const truckApi = {
  upsertVendor: (clientId, vendor) => adminPost({ action: "upsertVendor", clientId, vendor }),
  addBookings: (clientId, bookings, seriesId) => adminPost({ action: "addBookings", clientId, bookings, seriesId }),
  updateBooking: (id, patch) => api.updateBooking(id, patch),
  deleteBooking: (sel) => api.deleteBooking(sel),
};

// Stale-while-revalidate snapshot of the whole desk payload, keyed by the admin
// token (same pattern the portal ships). Null token -> no caching.
const DATA_CACHE_KEY = dataCacheKey("relay.desk.data", adminToken);

// Recovered from storage → put it back in the address bar.
if (adminToken && _access.source === "storage") {
  try {
    const u = new URL(location.href);
    u.searchParams.set("k", adminToken);
    history.replaceState(null, "", u.href);
  } catch { /* non-fatal */ }
}

function rememberAccess() {
  persistAccess(safeLocalStorage(), { token: adminToken, tokenKey: DESK_TOKEN_KEY });
}

// Make "Add to Home Screen" capture a launch link that carries the token.
async function setupLaunchManifest(tok) {
  try {
    const link = document.querySelector('link[rel="manifest"]');
    const manifestHref = new URL(link ? link.getAttribute("href") : "./manifest.webmanifest", location.href).href;
    let base;
    try {
      base = await (await fetch(manifestHref, { cache: "no-store" })).json();
    } catch {
      base = { name: "Relay Desk · Not Your Normal Marketing", short_name: "Relay Desk", display: "standalone", background_color: "#F2F2F7", theme_color: "#F2F2F7" };
    }
    installLaunchManifest({ doc: document, base, href: location.href, manifestHref, param: "k", token: tok });
  } catch { /* non-fatal: storage-restore still recovers the token */ }
}
if (adminToken) setupLaunchManifest(adminToken);

// ---------- tiny DOM helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (k === "value") node.value = v;
    else node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
};

let toastTimer = null;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

// ---------- formatting ----------
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function relTime(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const past = diff >= 0;
  const s = Math.round(Math.abs(diff) / 1000);
  const m = Math.round(s / 60);
  const h = Math.round(m / 60);
  const d = Math.round(h / 24);
  let label;
  if (s < 45) label = "just now";
  else if (m < 60) label = `${m} min`;
  else if (h < 24) label = `${h} hr`;
  else if (d < 7) label = `${d} day${d === 1 ? "" : "s"}`;
  else label = new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (label === "just now") return label;
  return past ? `${label} ago` : `in ${label}`;
}

function fmtEventDate(iso) {
  // "YYYY-MM-DD" parses as LOCAL midnight (matches the portal) — Date.parse would
  // read it as UTC and show the previous day in US timezones.
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(Date.parse(iso));
  if (Number.isNaN(d.getTime())) return { main: iso || "Date to be set", yr: "" };
  return {
    main: d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }),
    yr: String(d.getFullYear()),
  };
}

function fmtSchedule(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleString(undefined, {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

// "19:30" -> "7:30 PM" (locale-friendly). Empty/invalid -> "".
function fmtTime(t) {
  if (!t || !/^\d{1,2}:\d{2}$/.test(String(t))) return "";
  const [h, m] = String(t).split(":").map(Number);
  if (h > 23 || m > 59) return "";
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function initials(name = "") {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Clients hidden from the hub (not signed yet). Keeps them out of the queue,
// filters, events, and client list without touching live data.
const HIDDEN_CLIENTS = new Set(["a-new-day"]);

// Brand logo art bundled in the repo (shared/brands/<slug>.png). Keyed by brandSlug
// first, then clientId. Anything not listed falls back to a clean SF monogram.
const BRAND_LOGOS = {
  "the-o": "../shared/brands/the-o.png",
  "eats-on-601": "../shared/brands/eats-on-601.png",
};
function brandLogoSrc(client, clientId) {
  return (client && (BRAND_LOGOS[client.brandSlug] || BRAND_LOGOS[client.clientId])) ||
    BRAND_LOGOS[clientId] || "";
}

// An Apple-style squircle avatar: the brand's own logo when we have it, else a
// monogram of the client's initials on a tinted fill.
function brandAvatar(client, clientId) {
  const name = (client && client.name) || clientId || "";
  const src = brandLogoSrc(client, clientId);
  if (src) {
    const mark = el("div", { class: "brandmark" });
    const img = el("img", { src, alt: name, loading: "lazy" });
    img.addEventListener("error", () => { mark.classList.add("mono"); mark.textContent = initials(name); });
    mark.append(img);
    return mark;
  }
  return el("div", { class: "brandmark mono" }, initials(name));
}

const TYPE_LABEL = { post: "Post", website: "Website", design: "Design", "event-promo": "Event promo", other: "Other" };
function typeLabel(t) { return TYPE_LABEL[t] || t || "Request"; }

// stage -> { label, badge-class }
const STAGE_META = {
  submitted: { label: "New", cls: "bone" },
  queued: { label: "Sent to Claude", cls: "send" },
  drafting: { label: "Drafting", cls: "send" },
  ready: { label: "Ready to review", cls: "warn" },
  changes: { label: "Changes asked", cls: "warn" },
  approved: { label: "Approved", cls: "go" },
  shipping: { label: "Publishing", cls: "go" },
  done: { label: "Done", cls: "go" },
  error: { label: "Needs attention", cls: "err" },
};
function stageMeta(s) { return STAGE_META[s] || { label: s || "·", cls: "bone" }; }

// Stages that are waiting on Marshall, not on Claude or the worker. These drive
// the queue ordering, the Requests tab badge, and the aging tint.
const NEEDS_YOU_STAGES = new Set(["submitted", "changes", "ready", "error"]);
// Sort tier: needs-you first, then in-flight, done last.
function stageTier(s) {
  if (NEEDS_YOU_STAGES.has(s)) return 0;
  if (s === "done") return 2;
  return 1;
}

// Cards render compact (head + summary) with the heavy action surface collapsed.
// Needs-you stages that carry a one-tap action inside (Approve / Retry / change
// note) start expanded so nothing gets slower; fresh submissions stay compact so
// a morning triage of five requests is a scan, not a scroll. Derived from
// NEEDS_YOU_STAGES minus "submitted".
const AUTO_EXPAND_STAGES = new Set([...NEEDS_YOU_STAGES].filter((s) => s !== "submitted"));

// Marshall's explicit open/closed choices, keyed by request id, remembered with
// the stage they were made in. Survives poll re-renders; when the stage moves on
// (e.g. drafting -> ready) the stage default takes over again.
const cardExpandChoice = new Map();
function isCardExpanded(r) {
  const c = cardExpandChoice.get(r.id);
  if (c && c.stage === r.stage) return c.expanded;
  if (c) cardExpandChoice.delete(r.id); // stale: stage changed since the choice
  return AUTO_EXPAND_STAGES.has(r.stage);
}

// "2 days" / "5 hr" / "12 min" elapsed since the given time; "" when under a
// minute or unparsable. Used for the time-in-stage line on cards.
function sinceShort(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "";
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"}`;
}
const STALE_AFTER_MS = 24 * 60 * 60 * 1000; // needs-you/drafting older than this gets the attention tint

// Filter buckets: which stages each chip covers.
const STAGE_FILTERS = [
  { key: "all", label: "All", stages: null },
  { key: "new", label: "New", stages: ["submitted", "changes"] },
  { key: "progress", label: "In progress", stages: ["queued", "drafting", "approved", "shipping"] },
  { key: "ready", label: "Ready", stages: ["ready"] },
  { key: "done", label: "Done", stages: ["done"] },
];

// ---------- state ----------
const state = {
  view: "requests",
  clients: [],
  requests: [],
  events: [],
  // Food Trucks: the vendor registry + bookings come back on the admin load for
  // ALL clients; the Food Trucks tab scopes them to one food-truck client.
  vendors: [],
  bookings: [],
  clientById: {},
  filterStage: "all",
  filterClient: "all",
  // dirty comment text the user typed but hasn't saved, keyed by request id
  draftComments: {},
  // unsent change-note text (inline "Request changes" editor), keyed by request id.
  // A key existing (even empty) means the editor is open for that request.
  changeNotes: {},
  // Food Trucks tab UI: which food-truck client, which month (YYYY-MM anchor,
  // 1st of the month), and which day is expanded for editing (YYYY-MM-DD or "").
  truckClient: "",
  truckMonth: "",
  truckDay: "",
};

// Persist view + filters across relaunches (iOS kills PWAs constantly; keep his place).
const UI_STATE_KEY = "relay.desk.ui";
(function hydrateUiState() {
  const saved = readDataCache(safeLocalStorage(), UI_STATE_KEY);
  if (!saved) return;
  if (["requests", "events", "trucks", "history", "clients"].includes(saved.view)) state.view = saved.view;
  if (STAGE_FILTERS.some((f) => f.key === saved.filterStage)) state.filterStage = saved.filterStage;
  if (typeof saved.filterClient === "string" && saved.filterClient) state.filterClient = saved.filterClient;
  if (typeof saved.truckClient === "string") state.truckClient = saved.truckClient;
  if (typeof saved.truckMonth === "string" && /^\d{4}-\d{2}-01$/.test(saved.truckMonth)) state.truckMonth = saved.truckMonth;
})();
function saveUiState() {
  writeDataCache(safeLocalStorage(), UI_STATE_KEY, {
    view: state.view,
    filterStage: state.filterStage,
    filterClient: state.filterClient,
    truckClient: state.truckClient,
    truckMonth: state.truckMonth,
  });
}

let isBusy = false; // a mutation is in flight — pause polling/re-render races
let typingActive = false; // a comment box currently has focus
// Bumped every time a mutation finishes. A poll that started before a mutation
// compares this at resolve time and drops its (now stale) snapshot, so the UI
// never visually reverts an Approve/Retry/Delete that just landed.
let mutationEpoch = 0;

function setBusy(v) { isBusy = v; if (!v) mutationEpoch++; }

// ---------- API wrapper with friendly errors ----------
async function call(fn) {
  setBusy(true);
  try {
    const res = await fn();
    if (res && res.status === 403) { toast("Admin access was rejected."); return null; }
    if (res && res.ok === false) {
      toast(res.error || (res.errors && res.errors.join(", ")) || "That didn't go through.");
      return null;
    }
    if (res && (res.status === 409 || res.status >= 400)) {
      toast(res.error || "That change wasn't allowed.");
      return null;
    }
    return res;
  } catch {
    toast("Could not reach the desk. Check the connection.");
    return null;
  } finally {
    setBusy(false);
  }
}

// Apply a single updated request row back into state (from a mutation result).
function applyRequest(updated) {
  if (!updated || !updated.id) return;
  const i = state.requests.findIndex((r) => r.id === updated.id);
  if (i >= 0) state.requests[i] = updated;
  else state.requests.push(updated);
  delete state.draftComments[updated.id]; // server now holds the saved value
}

// ===================================================================
// Loading + auth
// ===================================================================
async function loadInitial() {
  if (!adminToken) return showBadToken();

  // Instant paint: render the last-known queue immediately while Apps Script
  // cold-starts (3-5s), then revalidate in the background. Same
  // stale-while-revalidate pattern the portal ships.
  const cached = DATA_CACHE_KEY ? readDataCache(safeLocalStorage(), DATA_CACHE_KEY) : null;
  const painted = !!(cached && cached.ok !== false && Array.isArray(cached.requests));
  if (painted) {
    ingest(cached);
    showApp();
    render();
  }

  const startedEpoch = mutationEpoch;
  let res;
  try { res = await api.load(); }
  catch { res = null; }
  if (!res || res.status === 403 || res.ok === false) {
    // With a cached queue on screen, a failure here is far more likely a
    // transient backend hiccup than a revoked token. Keep showing the data.
    if (!painted) showBadToken();
    return;
  }
  rememberAccess();
  if (DATA_CACHE_KEY) writeDataCache(safeLocalStorage(), DATA_CACHE_KEY, res);
  // A mutation landed while this load was in flight; its snapshot is stale.
  if (mutationEpoch !== startedEpoch) return;
  ingest(res);
  showApp();
  render();
}

function ingest(res) {
  state.clients = (Array.isArray(res.clients) ? res.clients : []).filter((c) => !HIDDEN_CLIENTS.has(c.clientId));
  state.requests = (Array.isArray(res.requests) ? res.requests : []).filter((r) => !HIDDEN_CLIENTS.has(r.clientId));
  state.events = (Array.isArray(res.events) ? res.events : []).filter((e) => !HIDDEN_CLIENTS.has(e.clientId));
  // Food Trucks: registry + schedule for every client; the tab scopes them itself.
  state.vendors = (Array.isArray(res.vendors) ? res.vendors : []).filter((v) => !HIDDEN_CLIENTS.has(v.clientId));
  state.bookings = (Array.isArray(res.bookings) ? res.bookings : []).filter((b) => !HIDDEN_CLIENTS.has(b.clientId));
  state.clientById = {};
  for (const c of state.clients) state.clientById[c.clientId] = c;
  // A persisted client filter may reference a client that no longer exists.
  if (state.filterClient !== "all" && !state.clientById[state.filterClient]) state.filterClient = "all";
  // Keep the Food Trucks tab's client selection valid; default to the first
  // food-truck client if unset or stale.
  const ftIds = truckClientIds();
  if (!ftIds.includes(state.truckClient)) state.truckClient = ftIds[0] || "";
  if (!state.truckMonth) state.truckMonth = monthAnchor(todayISO());
}

function showBadToken() {
  $("#view-loading").classList.add("hidden");
  $("#view-app").classList.add("hidden");
  $("#view-badtoken").classList.remove("hidden");
}
function showApp() {
  $("#view-loading").classList.add("hidden");
  $("#view-badtoken").classList.add("hidden");
  $("#view-app").classList.remove("hidden");
}

// ===================================================================
// Polling — refresh every 15s, but never clobber a focused comment box.
// ===================================================================
async function poll() {
  if (isBusy || typingActive || document.hidden) return; // skip this tick
  const startedEpoch = mutationEpoch;
  let res;
  try { res = await api.load(); }
  catch { return; } // transient; try again next tick
  if (!res || res.status === 403 || res.ok === false) return;
  // A mutation (Approve/Retry/Delete) landed while this poll was in flight; its
  // snapshot predates the mutation and would visually revert the card. Drop it.
  if (isBusy || mutationEpoch !== startedEpoch) return;
  if (DATA_CACHE_KEY) writeDataCache(safeLocalStorage(), DATA_CACHE_KEY, res);
  ingest(res);
  render();
}
setInterval(poll, 15000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });

// ===================================================================
// Top-level render dispatch
// ===================================================================
function clientName(clientId) {
  const c = state.clientById[clientId];
  return c ? c.name : clientId;
}

function render() {
  // counts — the Requests badge answers "how many things need ME right now",
  // not "how much total work is in flight" (Claude's in-progress items don't count).
  const needsYou = state.requests.filter((r) => NEEDS_YOU_STAGES.has(r.stage)).length;
  const unpromoted = state.events.filter((e) => !e.promoted).length;
  $("#count-requests").textContent = needsYou ? String(needsYou) : "";
  $("#count-events").textContent = unpromoted ? String(unpromoted) : "";
  $("#count-clients").textContent = state.clients.length ? String(state.clients.length) : "";
  // Food Trucks badge: how many trucks are booked in the month on screen for the
  // selected client — a quick "is this month filled in" signal.
  const truckN = state.truckClient
    ? scheduledBookings().filter((b) => b.clientId === state.truckClient && b.date.slice(0, 7) === String(state.truckMonth).slice(0, 7)).length
    : 0;
  $("#count-trucks").textContent = truckN ? String(truckN) : "";

  // tab active states
  for (const tab of document.querySelectorAll("#tabs .tab")) {
    const on = tab.dataset.view === state.view;
    tab.classList.toggle("active", on);
    tab.setAttribute("aria-selected", on ? "true" : "false");
  }
  $("#panel-requests").classList.toggle("hidden", state.view !== "requests");
  $("#panel-events").classList.toggle("hidden", state.view !== "events");
  $("#panel-trucks").classList.toggle("hidden", state.view !== "trucks");
  $("#panel-history").classList.toggle("hidden", state.view !== "history");
  $("#panel-clients").classList.toggle("hidden", state.view !== "clients");

  if (state.view === "requests") renderRequests();
  else if (state.view === "events") renderEvents();
  else if (state.view === "trucks") renderTrucks();
  else if (state.view === "history") renderHistory();
  else if (state.view === "clients") renderClients();
}

// ---------- tab switching ----------
$("#tabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (!tab) return;
  state.view = tab.dataset.view;
  saveUiState();
  render();
});

// ===================================================================
// REQUESTS view
// ===================================================================
function renderFilters() {
  // One horizontally scrollable rail: stage chips, a hairline divider, then
  // client chips (when more than one client exists). Saves a full row of
  // viewport on the phone vs the old two wrapped rows.
  const inClient = (r) => (state.filterClient === "all" ? true : r.clientId === state.filterClient);
  const rail = $("#filter-chips");
  const keepScroll = rail.scrollLeft;

  const chips = STAGE_FILTERS.map((f) => {
    const n = f.stages ? state.requests.filter((r) => f.stages.includes(r.stage) && inClient(r)).length : 0;
    return el("button", {
      type: "button",
      class: "chip sm" + (state.filterStage === f.key ? " active" : ""),
      onclick: () => { state.filterStage = f.key; saveUiState(); renderRequests(); },
    }, f.stages && n ? `${f.label} (${n})` : f.label);
  });

  if (state.clients.length > 1) {
    chips.push(el("span", { class: "chip-sep", "aria-hidden": "true" }));
    chips.push(
      el("button", {
        type: "button",
        class: "chip sm" + (state.filterClient === "all" ? " active" : ""),
        onclick: () => { state.filterClient = "all"; saveUiState(); renderRequests(); },
      }, "Everyone"),
      ...state.clients.map((c) =>
        el("button", {
          type: "button",
          class: "chip sm" + (state.filterClient === c.clientId ? " active" : ""),
          onclick: () => { state.filterClient = c.clientId; saveUiState(); renderRequests(); },
        }, c.name)
      )
    );
  }

  rail.replaceChildren(...chips);
  rail.scrollLeft = keepScroll; // don't jump the rail on re-render
}

function filteredRequests() {
  const f = STAGE_FILTERS.find((x) => x.key === state.filterStage) || STAGE_FILTERS[0];
  return state.requests
    .filter((r) => (f.stages ? f.stages.includes(r.stage) : true))
    .filter((r) => (state.filterClient === "all" ? true : r.clientId === state.filterClient))
    .slice()
    .sort((a, b) => {
      // Needs-you first, then Claude's in-flight work, done last. Newest first
      // within every tier so a fresh submission lands at the very top (it enters
      // as "submitted", a needs-you stage) instead of sinking under older ones.
      const ta = stageTier(a.stage);
      const tb = stageTier(b.stage);
      if (ta !== tb) return ta - tb;
      const ca = Date.parse(a.createdAt || 0) || 0;
      const cb = Date.parse(b.createdAt || 0) || 0;
      return cb - ca;
    });
}

function renderRequests() {
  renderFilters();
  const list = $("#requests-list");
  const rows = filteredRequests();

  if (!rows.length) {
    list.replaceChildren(
      el("div", { class: "card empty" },
        state.requests.length ? "No requests match this filter." : "No requests yet. They'll land here the moment a client submits one.")
    );
    return;
  }

  // Build a map of existing card nodes by request id so we can preserve
  // focus/typing on cards that haven't changed.
  const existing = new Map();
  for (const node of list.children) {
    if (node.dataset && node.dataset.reqId) existing.set(node.dataset.reqId, node);
  }

  const next = [];
  for (const r of rows) {
    const prev = existing.get(r.id);
    const holdsFocus = prev && prev.contains(document.activeElement);
    // Reuse the existing node if it holds focus (don't clobber typing) OR if it
    // is unchanged since last render.
    if (prev && (holdsFocus || prev.dataset.updatedAt === (r.updatedAt || ""))) {
      next.push(prev);
    } else {
      next.push(requestCard(r));
    }
  }
  list.replaceChildren(...next);
}

function requestCard(r) {
  const sm = stageMeta(r.stage);
  const cl = state.clientById[r.clientId] || {};
  const isDone = r.stage === "done";
  const expanded = isCardExpanded(r);

  const card = el("div", {
    class: "card req-card" + (isDone ? " is-done" : "") + (expanded ? " is-open" : ""),
    "data-req-id": r.id,
    "data-updated-at": r.updatedAt || "",
  });

  // Humanized time-in-stage ("in Drafting for 2 days"), from updatedAt. Ages
  // matter most where sitting still is a problem: needs-you stages and drafting
  // get an attention tint after 24h so quiet rot is visible at a glance.
  const stageAge = isDone ? "" : sinceShort(r.updatedAt);
  const stageT = Date.parse(r.updatedAt || "");
  const isStale = !isDone &&
    (NEEDS_YOU_STAGES.has(r.stage) || r.stage === "drafting") &&
    !Number.isNaN(stageT) && (Date.now() - stageT) > STALE_AFTER_MS;

  // Expand/collapse control: a real 44pt button for a11y; the whole head is the
  // tap target on top of it.
  const bodyId = `req-body-${r.id}`;
  const expandBtn = el("button", {
    type: "button",
    class: "req-expand",
    "aria-expanded": expanded ? "true" : "false",
    "aria-controls": bodyId,
    "aria-label": expanded ? "Hide details" : "Show details",
    html: CHEVRON_SVG,
  });

  // header — tapping it toggles the heavy body (except the delete control)
  const head = el("div", { class: "req-head" },
    brandAvatar(cl, r.clientId),
    el("div", { class: "req-headtext" },
      el("div", { class: "req-client" }, clientName(r.clientId)),
      el("div", { class: "req-badges" },
        el("span", { class: "badge bone" }, typeLabel(r.type)),
        el("span", { class: `badge ${sm.cls}` }, sm.label),
        el("span", { class: "req-when" }, relTime(r.createdAt)),
        stageAge ? el("span", { class: "req-stagetime" + (isStale ? " stale" : "") }, `in ${sm.label} for ${stageAge}`) : false
      )
    ),
    deleteRequestButton(r),
    expandBtn
  );
  head.addEventListener("click", (e) => {
    if (e.target.closest(".req-del")) return;
    const open = !card.classList.contains("is-open");
    // Animate only user-initiated opens. Bodies rendered already-open must never
    // depend on an animation to become visible (background tabs freeze CSS
    // animations at frame 0, leaving content stuck at opacity 0).
    card.classList.toggle("do-anim", open);
    card.classList.toggle("is-open", open);
    expandBtn.setAttribute("aria-expanded", open ? "true" : "false");
    expandBtn.setAttribute("aria-label", open ? "Hide details" : "Show details");
    cardExpandChoice.set(r.id, { stage: r.stage, expanded: open });
  });
  card.append(head);

  if (!isDone) {
    if (r.title) card.append(el("div", { class: "req-title" }, r.title));
    if (r.description) card.append(el("div", { class: "req-desc" }, r.description));
    // One-line staged-draft peek so a collapsed ready card still shows what
    // Claude made. Hidden (via CSS) once the card is open.
    const d = r.draft || {};
    const peek = d.caption || d.preview || d.summary || "";
    if (peek) card.append(el("div", { class: "req-peek" }, `Draft: ${peek}`));
  }

  // Everything heavy lives in the collapsible body.
  const body = el("div", { class: "req-body", id: bodyId });

  if (!isDone) {
    // Attachments — one row each: [preview] [name] [Save]. Tapping an image
    // opens it full-size in the lightbox; the Save button on every attachment
    // pulls the ORIGINAL file straight from Drive, so nothing has to be
    // screenshotted. Non-image files (e.g. PDFs) show a document tile instead.
    const atts = Array.isArray(r.attachments) ? r.attachments.filter((a) => a && a.url) : [];
    if (atts.length) {
      body.append(
        el("div", { class: "req-thumbs" },
          ...atts.map((a) => {
            const mime = a.mime || "";
            if (mime.startsWith("audio/")) {
              return el("audio", { class: "att-audio", controls: "controls", preload: "none", src: a.url });
            }
            const name = a.name || "attachment";
            const dl = driveDownload(a.url);
            const isImage = !mime || mime.startsWith("image/");

            const saveBtn = el("a", {
              class: "att-dl", href: dl, target: "_blank", rel: "noopener",
              download: name, title: `Download ${name}`, "aria-label": `Download ${name}`,
            }, el("span", { class: "att-dl-ico", html: DOWNLOAD_SVG }), "Save");

            let preview;
            if (isImage) {
              const full = driveEmbed(a.url, "w2000");
              preview = el("a", { class: "thumb zoomable", href: full, target: "_blank", rel: "noopener", title: name },
                el("img", { src: driveEmbed(a.url, "w1200"), alt: name, loading: "lazy" }));
              preview.addEventListener("click", (e) => { e.preventDefault(); openLightbox(full, name, { download: dl, name }); });
            } else {
              preview = el("span", { class: "thumb thumb-doc", "aria-hidden": "true", html: DOC_SVG });
            }

            return el("div", { class: "att" },
              preview,
              el("div", { class: "att-meta" },
                el("div", { class: "att-name" }, name),
                el("div", { class: "att-sub" }, isImage ? "Tap to enlarge" : (/pdf/i.test(mime) ? "PDF" : "Document"))),
              saveBtn
            );
          })
        )
      );
    }
  }

  body.append(actionArea(r));
  body.append(threadSection(r));
  card.append(body);
  return card;
}

// Quiet destructive control in each request's header. Lets a test or accidental
// submission be removed from the history. Admin-gated server-side; confirmed here.
function deleteRequestButton(r) {
  const btn = el("button", {
    type: "button",
    class: "req-del",
    title: "Delete request",
    "aria-label": "Delete request",
    html: TRASH_SVG,
  });
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const label = r.title || typeLabel(r.type);
    if (!window.confirm(`Delete this request (${label})? It is removed from the history and cannot be undone.`)) return;
    const res = await call(() => api.remove(r.id));
    if (res) {
      const i = state.requests.findIndex((x) => x.id === r.id);
      if (i >= 0) state.requests.splice(i, 1);
      delete state.draftComments[r.id];
      toast("Request deleted.");
      render();
    }
  });
  return btn;
}

// Two-way conversation thread on a request (client <-> team), team perspective.
function threadSection(r) {
  const thread = (r.meta && Array.isArray(r.meta.thread)) ? r.meta.thread : [];
  const wrap = el("div", { class: "thread" });
  wrap.append(el("div", { class: "thread-label" }, thread.length ? "Conversation" : "Message this client"));
  if (thread.length) {
    const list = el("div", { class: "thread-list" });
    for (const m of thread) {
      const mine = m.from === "team";
      list.append(el("div", { class: "msg " + (mine ? "mine" : "theirs") },
        el("div", { class: "msg-bubble" }, m.text),
        el("div", { class: "msg-meta" }, `${mine ? "You" : clientName(r.clientId)} · ${relTime(m.at)}`)
      ));
    }
    wrap.append(list);
  }
  const ta = el("textarea", { id: `msg-${r.id}`, class: "thread-input", rows: "1", placeholder: "Reply to the client" });
  ta.addEventListener("focus", () => { typingActive = true; });
  ta.addEventListener("blur", () => { typingActive = false; });
  const send = el("button", { type: "button", class: "btn sm" }, "Send");
  send.addEventListener("click", async () => {
    const text = ta.value.trim();
    if (!text) { toast("Type a message first."); return; }
    const res = await call(() => api.message(r.id, text));
    if (res) { applyRequest(res.request); toast("Message sent."); render(); }
  });
  wrap.append(el("div", { class: "thread-reply" }, ta, send));
  return wrap;
}

// ---------- stage-dependent action area ----------
function actionArea(r) {
  const stage = r.stage;
  if (stage === "submitted" || stage === "changes") return commentActions(r);
  if (stage === "queued" || stage === "drafting") return buildingStatus(r);
  if (stage === "ready") return readyActions(r);
  if (stage === "approved" || stage === "shipping") return shippingStatus(r);
  if (stage === "error") return errorActions(r);
  if (stage === "done") return doneActions(r);
  return el("div", { class: "act" }, el("div", { class: "statusline" }, stageMeta(stage).label));
}

function commentActions(r) {
  const wrap = el("div", { class: "act stack" });

  if (r.stage === "changes" && r.changeNote) {
    wrap.append(el("div", { class: "notebox" },
      el("strong", {}, "Changes you asked for: "), document.createTextNode(r.changeNote)));
  }

  const initial = r.id in state.draftComments ? state.draftComments[r.id] : (r.comment || "");
  const ta = el("textarea", { id: `cmt-${r.id}`, placeholder: "Anything Claude should know: tone, channel, must-haves, what to avoid." });
  ta.value = initial;
  ta.addEventListener("focus", () => { typingActive = true; });
  ta.addEventListener("input", () => { state.draftComments[r.id] = ta.value; });
  ta.addEventListener("blur", () => { typingActive = false; });

  wrap.append(el("label", { for: `cmt-${r.id}` }, "Context for Claude"));
  wrap.append(ta);

  const sendBtn = el("button", { type: "button", class: "btn send" }, "Send to Claude");
  sendBtn.addEventListener("click", async () => {
    const res = await call(() => api.update(r.id, { action: "send", comment: ta.value }));
    if (res) { applyRequest(res.request); toast("Sent to Claude."); render(); }
  });

  const saveBtn = el("button", { type: "button", class: "btn ghost sm" }, "Save note");
  saveBtn.addEventListener("click", async () => {
    const res = await call(() => api.update(r.id, { comment: ta.value }));
    if (res) { applyRequest(res.request); toast("Note saved."); render(); }
  });

  wrap.append(el("div", { class: "btn-row" }, sendBtn, saveBtn));

  // Dev stand-in: run the whole loop so the draft can be demoed without the worker.
  // Mock mode only — never render this on the live Desk.
  if (API_MODE === "mock") {
    const devBtn = el("button", { type: "button", class: "btn ghost sm dev" }, "▸ Simulate draft (dev)");
    devBtn.addEventListener("click", () => simulateDraft(r, ta.value));
    wrap.append(devBtn);
    wrap.append(el("div", { class: "dev-note" }, "Dev stand-in: the real worker stages the draft. This fakes it so the review loop can be tried out."));
  }

  return wrap;
}

// Walks a request from submitted/changes all the way to a staged `ready` draft.
async function simulateDraft(r, comment) {
  setBusy(true);
  try {
    // current stage may be submitted or changes; both need a `start` to reach drafting.
    let cur = r.stage;
    if (cur === "submitted") {
      const sent = await safeUpdate(r.id, { action: "send", comment });
      if (!sent) return;
      cur = "queued";
    }
    const started = await safeUpdate(r.id, { action: "start" });
    if (!started) return;
    const ready = await safeUpdate(r.id, {
      action: "ready",
      draft: {
        caption: `Sample staged caption for "${r.title || typeLabel(r.type)}".`,
        preview: `Staged ${typeLabel(r.type).toLowerCase()} draft (simulated).`,
        summary: "Simulated by dev button: the real worker stages this.",
        channel: "Facebook + Instagram",
      },
      scheduledFor: "",
    });
    if (!ready) return;
    applyRequest(ready.request);
    toast("Draft staged (simulated).");
    render();
  } finally {
    setBusy(false);
  }
}

// Like call() but without toggling isBusy (the caller owns that), still surfaces errors.
async function safeUpdate(id, patch) {
  try {
    const res = await api.update(id, patch);
    if (!res || res.ok === false || res.status === 403 || res.status === 409 || res.status >= 400) {
      toast((res && res.error) || "Simulation step was blocked.");
      return null;
    }
    return res;
  } catch {
    toast("Could not reach the desk.");
    return null;
  }
}

function buildingStatus(r) {
  const skill = r.meta && r.meta.run && r.meta.run.skill;
  const wrap = el("div", { class: "act stack" });
  wrap.append(el("div", { class: "statusline" },
    el("span", { class: "dot" }),
    document.createTextNode(r.stage === "queued" ? "Queued for Claude…" : "Sent to Claude, building the draft…"),
    skill ? el("span", { class: "skill" }, `· ${skill}`) : false
  ));
  // Manual recovery: if a draft stalls (e.g. the worker hit a snag), re-queue it.
  const reset = el("button", { type: "button", class: "btn ghost sm" }, "Reset to queue");
  reset.addEventListener("click", async () => {
    if (!window.confirm("Reset this request back to the queue? The worker will pick it up again on its next run.")) return;
    const res = await call(() => api.update(r.id, { stage: "queued", draft: null }));
    if (res) { applyRequest(res.request); toast("Reset to the queue."); render(); }
  });
  wrap.append(el("div", { class: "btn-row" }, reset));
  wrap.append(el("div", { class: "dev-note" }, "If a draft seems stuck, Reset re-queues it for the next worker run."));
  return wrap;
}

function shippingStatus(r) {
  const txt = r.stage === "approved" ? "Approved, publishing…" : "Publishing…";
  const wrap = el("div", { class: "act stack" });
  wrap.append(el("div", { class: "statusline go" }, el("span", { class: "dot" }), document.createTextNode(txt)));

  // Cancel window: while the worker hasn't picked the request up yet, an approve
  // can still be pulled back. Same direct-stage patch Retry/Reset already use;
  // if the worker grabbed it first the server rejects and the next poll reconciles.
  if (r.stage === "approved") {
    const back = el("button", { type: "button", class: "btn ghost sm" }, "Back to review");
    back.addEventListener("click", async () => {
      const res = await call(() => api.update(r.id, { stage: "ready" }));
      if (res) { applyRequest(res.request); toast("Pulled back for review. Nothing was published."); render(); }
    });
    wrap.append(el("div", { class: "btn-row" }, back));
    wrap.append(el("div", { class: "dev-note" }, "Not shipped yet. Back to review pulls it out of the publish queue."));
  }
  return wrap;
}

function errorActions(r) {
  const wrap = el("div", { class: "act stack" });
  const msg = (r.meta && r.meta.run && r.meta.run.error) || "Something went wrong while building this.";
  wrap.append(el("div", { class: "notebox err" }, el("strong", {}, "Error: "), document.createTextNode(msg)));
  const retry = el("button", { type: "button", class: "btn ghost sm" }, "Retry");
  retry.addEventListener("click", async () => {
    const run = (r.meta && r.meta.run) || {};
    // Publish-phase failure with a draft: the creative is already reviewed and
    // approved, so FIRST try the V7 first-class requeue action — the backend keeps
    // the draft and puts the request straight back in the SHIP lane ("approved").
    // The live V6 backend doesn't know the action and rejects it (illegal
    // transition); fall through SILENTLY to the legacy patch below, so the Desk
    // works today and auto-upgrades the moment V7 deploys.
    if (run.phase === "publish" && r.draft) {
      setBusy(true);
      try {
        const rq = await api.update(r.id, { action: "requeue" });
        if (rq && rq.ok !== false && !(rq.status >= 400) && rq.request) {
          applyRequest(rq.request);
          toast("Re-queued to publish — the approved draft was kept.");
          render();
          return;
        }
      } catch {
        // network blip — the legacy path below surfaces real errors
      } finally {
        setBusy(false);
      }
    }
    // Legacy path (V6 live today): direct re-queue for a fresh draft — NOT
    // action:"start", which maps error->drafting, a stage the worker ignores (it
    // only picks up "queued"), so the request would strand. Clearing run.error
    // stops the Desk showing the stale failure once it's back in the queue.
    const meta = { ...(r.meta || {}), run: { ...run, error: "" } };
    const res = await call(() => api.update(r.id, { stage: "queued", draft: null, meta }));
    if (res) { applyRequest(res.request); toast("Back in the queue."); render(); }
  });
  wrap.append(el("div", { class: "btn-row" }, retry));
  return wrap;
}

// Format channel ids ("facebook","instagram") for display: FB first, title-cased,
// joined with " + ". Shared by the draft preview head + the done card.
function fmtChannels(channels) {
  const order = { facebook: 0, instagram: 1 };
  const names = { facebook: "Facebook", instagram: "Instagram" };
  return (channels || [])
    .slice()
    .sort((a, b) => (order[a] ?? 9) - (order[b] ?? 9))
    .map((c) => names[c] || (c ? c[0].toUpperCase() + c.slice(1) : c))
    .join(" + ");
}

function fmtWhen(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function doneActions(r) {
  const run = (r.meta && r.meta.run) || {};
  const where = fmtChannels(Array.isArray(run.channels) ? run.channels : []);
  if (!where) {
    // Non-social done (e.g. a website apply) or an older row without run.channels.
    return el("div", { class: "act" },
      el("div", { class: "statusline go" }, el("span", { class: "dot" }), document.createTextNode("Done")));
  }
  const wrap = el("div", { class: "act stack" });
  const when = run.finishedAt ? fmtWhen(run.finishedAt) : "";
  wrap.append(el("div", { class: "statusline go" }, el("span", { class: "dot" }),
    document.createTextNode(`Published to ${where}${when ? ` · ${when}` : ""}`)));
  if (run.status === "shipped-partial" && Array.isArray(run.failures) && run.failures.length) {
    wrap.append(el("div", { class: "notebox" }, el("strong", {}, "Heads up: "),
      document.createTextNode("Didn't post to " + run.failures.map((f) => f.channel).join(", ") + "; handle those manually.")));
  }
  wrap.append(el("a", { href: "https://postiz.notyournormalmarketing.com/launches", target: "_blank", rel: "noopener", class: "kv link" }, "View in Postiz →"));
  return wrap;
}

// Drive "view" URLs (.../d/FILEID/view) aren't embeddable in <img>; convert to
// the thumbnail endpoint. `size` lets the lightbox request a larger render than the
// inline preview. Non-Drive URLs (local mock, direct links) pass through.
function driveEmbed(url, size = "w1200") {
  if (!url) return url;
  if (/drive\.google\.com/.test(url)) {
    const m = String(url).match(/\/d\/([a-zA-Z0-9_-]+)|[?&]id=([a-zA-Z0-9_-]+)/);
    const id = m && (m[1] || m[2]);
    if (id) return `https://drive.google.com/thumbnail?id=${id}&sz=${size}`;
  }
  return url;
}

// The stored attachment URL is a Drive *thumbnail* (a resized render). For a
// real download we want the ORIGINAL file, so rewrite it to Drive's direct
// export endpoint. Non-Drive URLs (local mock, direct links) pass through.
function driveDownload(url) {
  if (!url) return url;
  if (/drive\.google\.com/.test(url)) {
    const m = String(url).match(/\/d\/([a-zA-Z0-9_-]+)|[?&]id=([a-zA-Z0-9_-]+)/);
    const id = m && (m[1] || m[2]);
    if (id) return `https://drive.google.com/uc?export=download&id=${id}`;
  }
  return url;
}

function readyActions(r) {
  const wrap = el("div", { class: "act" });
  const d = r.draft || {};
  const channelLabel = d.channel
    ? fmtChannels(String(d.channel).split(/[,+]/).map((s) => s.trim().toLowerCase()).filter(Boolean))
    : "";

  const panel = el("div", { class: "draft" });
  panel.append(el("div", { class: "draft-head" },
    document.createTextNode("Staged draft"),
    channelLabel ? el("span", {}, channelLabel) : false
  ));

  const body = el("div", { class: "draft-body" });
  if (d.imageUrl) {
    // Inline preview is cropped (cover); tap it to see the whole image (contain) in the lightbox.
    const img = el("img", { class: "draft-img", src: driveEmbed(d.imageUrl, "w1200"), alt: "Staged draft", loading: "lazy" });
    img.addEventListener("error", () => { img.style.display = "none"; });
    makeZoomable(img, driveEmbed(d.imageUrl, "w2000"));
    body.append(img);
  }
  if (d.caption) body.append(el("div", { class: "draft-caption" }, d.caption));

  const kv = el("div", { class: "draft-meta" });
  if (d.preview) kv.append(el("div", { class: "kv" }, el("b", {}, "Preview: "), document.createTextNode(d.preview)));
  if (channelLabel) kv.append(el("div", { class: "kv" }, el("b", {}, "Channel: "), document.createTextNode(channelLabel)));
  const sched = fmtSchedule(d.scheduledFor || r.scheduledFor);
  if (sched) kv.append(el("div", { class: "kv" }, el("b", {}, "Scheduled: "), document.createTextNode(sched)));
  if (kv.children.length) body.append(kv);
  if (d.summary) body.append(el("div", { class: "draft-summary" }, d.summary));
  panel.append(body);
  wrap.append(panel);

  const isSocial = r.type === "post" || r.type === "event-promo";
  const approve = el("button", { type: "button", class: "btn go" }, isSocial ? "Approve & publish" : "Approve");
  approve.addEventListener("click", async () => {
    if (isSocial) {
      const clientName = (state.clientById[r.clientId] && state.clientById[r.clientId].name) || r.clientId;
      const where = channelLabel || "Facebook + Instagram";
      if (!window.confirm(`Approve and publish to ${clientName}'s ${where}? This goes live automatically.`)) return;
    }
    const res = await call(() => api.update(r.id, { action: "approve" }));
    if (res) { applyRequest(res.request); toast(isSocial ? "Approved. Publishing…" : "Approved."); render(); }
  });

  // Inline change-note editor (replaces window.prompt): the draft stays visible
  // while typing, and unsent text survives re-renders via state.changeNotes.
  const noteOpen = r.id in state.changeNotes;
  const noteBox = el("div", { class: "changenote" + (noteOpen ? "" : " hidden") });
  const noteTa = el("textarea", { id: `chg-${r.id}`, placeholder: "Be specific: copy, image, schedule, channel." });
  noteTa.value = noteOpen ? state.changeNotes[r.id] : "";
  noteTa.addEventListener("focus", () => { typingActive = true; });
  noteTa.addEventListener("input", () => { state.changeNotes[r.id] = noteTa.value; });
  noteTa.addEventListener("blur", () => { typingActive = false; });
  const sendBack = el("button", { type: "button", class: "btn" }, "Send back to Claude");
  sendBack.addEventListener("click", async () => {
    const trimmed = noteTa.value.trim();
    if (!trimmed) { toast("Add a short note so Claude knows what to change."); noteTa.focus(); return; }
    const res = await call(() => api.update(r.id, { action: "requestChanges", changeNote: trimmed }));
    if (res) { delete state.changeNotes[r.id]; applyRequest(res.request); toast("Sent back for changes."); render(); }
  });
  noteBox.append(
    el("label", { for: `chg-${r.id}` }, "What should change?"),
    noteTa,
    el("div", { class: "btn-row" }, sendBack)
  );

  const changes = el("button", { type: "button", class: "btn ghost" }, "Request changes");
  changes.addEventListener("click", () => {
    const opening = noteBox.classList.contains("hidden");
    if (opening) {
      if (!(r.id in state.changeNotes)) state.changeNotes[r.id] = "";
      noteBox.classList.remove("hidden");
      noteTa.focus();
    } else {
      noteBox.classList.add("hidden");
      if (!noteTa.value.trim()) delete state.changeNotes[r.id];
    }
  });

  wrap.append(el("div", { class: "btn-row" }, approve, changes));
  wrap.append(noteBox);
  return wrap;
}

// ===================================================================
// EVENTS view
// ===================================================================
// Local "today" as YYYY-MM-DD (no UTC surprises) — same date semantics as the
// portal's past-event filter, so both apps flip an event to "past" at local midnight.
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Soonest first; undated events sink to the end instead of floating to the top.
function cmpEventDateAsc(a, b) {
  const da = String((a && a.date) || "");
  const db = String((b && b.date) || "");
  if (!da && !db) return 0;
  if (!da) return 1;
  if (!db) return -1;
  return da.localeCompare(db);
}

function renderEvents() {
  const list = $("#events-list");
  // Upcoming (incl. today + undated) soonest-first on top; past events sink to the
  // bottom, dimmed, most recently passed first. Local-date string compare matches
  // the portal — no UTC parse pushing a late-night event into "past" early.
  const today = todayISO();
  const isPast = (e) => { const d = String((e && e.date) || "").slice(0, 10); return !!d && d < today; };
  const upcoming = state.events.filter((e) => !isPast(e)).sort(cmpEventDateAsc);
  const past = state.events.filter(isPast).sort((a, b) => cmpEventDateAsc(b, a));
  const rows = [...upcoming, ...past];

  if (!rows.length) {
    list.replaceChildren(el("div", { class: "card empty" }, "No events yet. Clients add these from their portal."));
    return;
  }

  list.replaceChildren(...rows.map((e) => eventCard(e, isPast(e))));
}

function eventCard(e, past = false) {
  const d = fmtEventDate(e.date);
  const startT = fmtTime(e.time);
  const endT = fmtTime(e.endTime);
  const timeText = startT ? (endT ? `${startT} – ${endT}` : startT) : "";
  const card = el("div", { class: past ? "card is-past" : "card" });

  card.append(el("div", { class: "req-head" },
    brandAvatar(state.clientById[e.clientId], e.clientId),
    el("div", { class: "req-headtext" },
      el("div", { class: "req-client" }, clientName(e.clientId)),
      el("div", { class: "evt-date" }, d.main + (timeText ? ` at ${timeText}` : ""), el("span", { class: "yr" }, d.yr))
    ),
    e.promoted ? el("span", { class: "badge go" }, "Promoted") : false
  ));

  if (e.title) card.append(el("div", { class: "req-title" }, e.title));
  if (e.description) card.append(el("div", { class: "req-desc" }, e.description));

  if (!e.promoted) {
    const btn = el("button", { type: "button", class: "btn primary block", style: "margin-top:14px" }, "Promote into a post");
    btn.addEventListener("click", async () => {
      const res = await call(() => api.promote(e.eventId));
      if (res) {
        // reflect promoted locally, then full refresh to pull in the new request
        const i = state.events.findIndex((x) => x.eventId === e.eventId);
        if (i >= 0) state.events[i] = { ...state.events[i], promoted: true, requestId: res.requestId || "" };
        toast("Added to the queue.");
        render();
        poll();
      }
    });
    card.append(btn);
  }

  return card;
}

// ===================================================================
// FOOD TRUCKS view — a month calendar of truck bookings for one food-truck
// client (default Eats on 601). Marshall can add / edit time+note / cancel a
// day's trucks here, the same capabilities the client has in the portal, for
// when he schedules on their behalf. The monthly schedule graphic still gets
// approved through the normal Requests ready→approve flow — nothing here posts.
// ===================================================================
const LOT_START = "09:00"; // default lot hours (spec §2, decision 5): 9A–5P
const LOT_END = "17:00";
// The category set the website's vendorGroups understands; "+ Add a new truck"
// constrains category to this so grouping/rendering stays valid.
const VENDOR_CATEGORIES = [
  "TACOS", "BBQ", "BURGERS", "PIZZA", "CARIBBEAN", "SEAFOOD", "ASIAN", "MEXICAN",
  "SOUTHERN", "BREAKFAST", "DESSERTS", "COFFEE", "DRINKS", "SNACKS", "VEGAN", "OTHER",
];
const VENDOR_PRICES = ["$", "$$", "$$$"];

// Clients that get the Food Trucks tab: those with features.foodTrucks. If none
// are flagged (older data), fall back to any client that already has vendors so
// the tab is never uselessly empty.
const FOOD_TRUCK_CLIENT_IDS = new Set(["eats-on-601"]);
function truckClientIds() {
  const flagged = state.clients.filter((c) => (c.features && c.features.foodTrucks) || FOOD_TRUCK_CLIENT_IDS.has(c.clientId)).map((c) => c.clientId);
  if (flagged.length) return flagged;
  const withVendors = [...new Set(state.vendors.map((v) => v.clientId))].filter((id) => state.clientById[id]);
  return withVendors;
}

// Only real (scheduled) bookings — the backend already drops cancelled ones from
// the client payload, but the admin payload can carry them, so guard here too.
function scheduledBookings() {
  return state.bookings.filter((b) => b && b.status !== "cancelled");
}

// "YYYY-MM-DD" -> "YYYY-MM-01" anchor for the month it belongs to.
function monthAnchor(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-01` : monthAnchor(todayISO());
}
// Shift a month anchor by ±1 month, staying on the 1st.
function shiftMonth(anchor, delta) {
  const m = String(anchor).match(/^(\d{4})-(\d{2})/);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1 + delta, 1) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
// "9A–5P" compact hours from "09:00"/"17:00" (mirrors the site's compactTime style).
function compactHours(start, end) {
  const one = (t) => {
    const mm = String(t || "").match(/^(\d{1,2}):(\d{2})$/);
    if (!mm) return "";
    let h = Number(mm[1]);
    const min = mm[2];
    const ap = h < 12 ? "A" : "P";
    h = h % 12; if (h === 0) h = 12;
    return min === "00" ? `${h}${ap}` : `${h}:${min}${ap}`;
  };
  const s = one(start), e = one(end);
  if (!s && !e) return "";
  return e ? `${s}–${e}` : s;
}

// A day-cell date (YYYY-MM-DD) for a given year/month(0-based)/day.
function ymd(y, m0, day) {
  return `${y}-${String(m0 + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function trucksForDay(clientId, dateISO) {
  return scheduledBookings()
    .filter((b) => b.clientId === clientId && b.date === dateISO)
    .sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)) || String(a.vendorName).localeCompare(String(b.vendorName)));
}

function renderTrucks() {
  const body = $("#trucks-body");
  const ftIds = truckClientIds();

  if (!ftIds.length) {
    body.replaceChildren(el("div", { class: "card empty" },
      "No food-truck clients yet. Turn on a client's food-truck scheduling to manage a lineup here."));
    return;
  }
  if (!ftIds.includes(state.truckClient)) state.truckClient = ftIds[0];
  if (!state.truckMonth) state.truckMonth = monthAnchor(todayISO());

  const parts = [];

  // Client scope selector — only when more than one client has food trucks.
  if (ftIds.length > 1) {
    const rail = el("div", { class: "chip-row", "aria-label": "Choose a food-truck client" },
      ...ftIds.map((id) =>
        el("button", {
          type: "button",
          class: "chip sm" + (state.truckClient === id ? " active" : ""),
          onclick: () => { state.truckClient = id; state.truckDay = ""; saveUiState(); renderTrucks(); },
        }, clientName(id)))
    );
    parts.push(el("div", { class: "filters" }, rail));
  }

  parts.push(monthHeader());
  parts.push(monthGrid());

  body.replaceChildren(...parts);
}

// Prev / month-label / next, plus a "Today" jump when we're off the current month.
function monthHeader() {
  const anchor = state.truckMonth;
  const m = anchor.match(/^(\d{4})-(\d{2})/);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, 1);
  const label = d.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const prev = el("button", { type: "button", class: "cal-nav", "aria-label": "Previous month" },
    el("span", { "aria-hidden": "true" }, "‹"));
  prev.addEventListener("click", () => { state.truckMonth = shiftMonth(anchor, -1); state.truckDay = ""; saveUiState(); renderTrucks(); });

  const next = el("button", { type: "button", class: "cal-nav", "aria-label": "Next month" },
    el("span", { "aria-hidden": "true" }, "›"));
  next.addEventListener("click", () => { state.truckMonth = shiftMonth(anchor, 1); state.truckDay = ""; saveUiState(); renderTrucks(); });

  const head = el("div", { class: "cal-head" },
    prev,
    el("div", { class: "cal-title" }, label),
    next
  );

  const onThisMonth = monthAnchor(todayISO()) === anchor;
  if (!onThisMonth) {
    const today = el("button", { type: "button", class: "btn ghost sm cal-today" }, "Today");
    today.addEventListener("click", () => {
      state.truckMonth = monthAnchor(todayISO());
      state.truckDay = todayISO();
      saveUiState();
      renderTrucks();
    });
    head.append(today);
  }
  return head;
}

// The month grid: weekday header row + day cells. Each cell shows its trucks
// (name · hours · category). Tapping a cell opens its editor below the grid.
function monthGrid() {
  const clientId = state.truckClient;
  const m = state.truckMonth.match(/^(\d{4})-(\d{2})/);
  const year = Number(m[1]);
  const month0 = Number(m[2]) - 1;
  const first = new Date(year, month0, 1);
  const startWeekday = first.getDay(); // 0=Sun
  const daysInMonth = new Date(year, month0 + 1, 0).getDate();
  const today = todayISO();

  const wrap = el("div", { class: "cal" });

  // weekday header
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  wrap.append(el("div", { class: "cal-dow" }, ...dow.map((n) => el("div", { class: "cal-dowcell" }, n))));

  const grid = el("div", { class: "cal-grid", role: "grid", "aria-label": "Month schedule" });
  // leading blanks
  for (let i = 0; i < startWeekday; i++) grid.append(el("div", { class: "cal-cell empty", "aria-hidden": "true" }));

  for (let day = 1; day <= daysInMonth; day++) {
    const dateISO = ymd(year, month0, day);
    const trucks = trucksForDay(clientId, dateISO);
    const isToday = dateISO === today;
    const isOpen = state.truckDay === dateISO;

    const cell = el("button", {
      type: "button",
      class: "cal-cell" + (isToday ? " today" : "") + (trucks.length ? " has" : "") + (isOpen ? " open" : ""),
      role: "gridcell",
      "aria-label": `${new Date(year, month0, day).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}, ${trucks.length} truck${trucks.length === 1 ? "" : "s"}`,
      "aria-pressed": isOpen ? "true" : "false",
    });
    cell.append(el("div", { class: "cal-daynum" }, String(day)));
    if (trucks.length) {
      const tags = el("div", { class: "cal-trucks" });
      for (const b of trucks.slice(0, 3)) {
        tags.append(el("div", { class: "cal-truck", title: `${vendorNameFor(b)} · ${compactHours(b.startTime, b.endTime)}` }, vendorNameFor(b)));
      }
      if (trucks.length > 3) tags.append(el("div", { class: "cal-more" }, `+${trucks.length - 3} more`));
      cell.append(tags);
    }
    cell.addEventListener("click", () => {
      state.truckDay = isOpen ? "" : dateISO;
      saveUiState();
      renderTrucks();
    });
    grid.append(cell);
  }
  wrap.append(grid);

  // Day editor drops in directly under the grid when a day is selected.
  if (state.truckDay && state.truckDay.slice(0, 7) === `${year}-${String(month0 + 1).padStart(2, "0")}`) {
    wrap.append(dayEditor(clientId, state.truckDay));
  }
  return wrap;
}

// The expanded day: existing trucks (edit hours/note, cancel) + an add-a-truck row.
function dayEditor(clientId, dateISO) {
  const dParts = dateISO.split("-");
  const dObj = new Date(Number(dParts[0]), Number(dParts[1]) - 1, Number(dParts[2]));
  const heading = dObj.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const card = el("div", { class: "card day-editor" });

  const close = el("button", { type: "button", class: "req-del", "aria-label": "Close day", title: "Close" },
    el("span", { "aria-hidden": "true", style: "font-size:22px;line-height:1" }, "×"));
  close.addEventListener("click", () => { state.truckDay = ""; saveUiState(); renderTrucks(); });

  card.append(el("div", { class: "spread" },
    el("div", { class: "day-heading" }, heading),
    close
  ));

  const trucks = trucksForDay(clientId, dateISO);
  const list = el("div", { class: "truck-list" });
  if (!trucks.length) {
    list.append(el("div", { class: "muted small", style: "padding:8px 0" }, "No trucks booked yet for this day."));
  } else {
    for (const b of trucks) list.append(truckRow(b));
  }
  card.append(list);

  card.append(addTruckRow(clientId, dateISO));
  return card;
}

// One booked truck: name + category, hours, note; edit (time/note) + cancel.
function truckRow(b) {
  const row = el("div", { class: "truck-row", "data-bkg": b.id });
  const cat = b.category || vendorCategory(b.vendorId);

  const editing = state._editingBooking === b.id;

  const info = el("div", { class: "truck-info" },
    el("div", { class: "truck-name" }, vendorNameFor(b)),
    el("div", { class: "truck-sub" },
      compactHours(b.startTime, b.endTime),
      cat ? el("span", { class: "truck-cat" }, cat) : false,
      b.note ? el("span", { class: "truck-note" }, b.note) : false
    )
  );

  const editBtn = el("button", { type: "button", class: "btn ghost sm", "aria-expanded": editing ? "true" : "false" }, editing ? "Close" : "Edit");
  editBtn.addEventListener("click", () => {
    state._editingBooking = editing ? "" : b.id;
    renderTrucks();
  });

  const renameBtn = el("button", { type: "button", class: "btn ghost sm" }, "Rename");
  renameBtn.addEventListener("click", async () => {
    const v = state.vendors.find((x) => x.id === b.vendorId && x.clientId === b.clientId);
    if (!v) { toast("That truck isn't in the registry."); return; }
    const name = window.prompt("Fix the truck's name (updates the calendar and the website):", v.name || "");
    if (name == null) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed === v.name) return;
    // Same id + new name = rename in place; the backend rewrites booking snapshots.
    const res = await call(() => truckApi.upsertVendor(b.clientId, {
      id: v.id, name: trimmed, category: v.category, price: v.price || "$$",
      tagline: v.tagline || "", active: v.active !== false,
    }));
    if (res) {
      v.name = trimmed;
      for (const x of state.bookings) if (x.vendorId === v.id && x.clientId === b.clientId) x.vendorName = trimmed;
      toast("Name fixed everywhere.");
      renderTrucks();
    }
  });

  const cancelBtn = el("button", { type: "button", class: "btn danger sm" }, "Cancel");
  cancelBtn.addEventListener("click", async () => {
    if (!window.confirm(`Remove ${vendorNameFor(b)} from ${b.date}? This can't be undone.`)) return;
    const res = await call(() => api.deleteBooking({ id: b.id }));
    if (res) {
      state.bookings = state.bookings.filter((x) => x.id !== b.id);
      if (state._editingBooking === b.id) state._editingBooking = "";
      toast("Truck removed.");
      renderTrucks();
    }
  });

  row.append(el("div", { class: "truck-row-main" }, info, el("div", { class: "truck-row-actions" }, editBtn, renameBtn, cancelBtn)));

  if (editing) row.append(editTruckForm(b));
  return row;
}

// Inline edit form for a booking: start/end time + note -> updateBooking.
function editTruckForm(b) {
  const form = el("div", { class: "truck-edit" });
  const startI = el("input", { type: "time", id: `bstart-${b.id}`, value: b.startTime || LOT_START, "aria-label": "Start time" });
  const endI = el("input", { type: "time", id: `bend-${b.id}`, value: b.endTime || LOT_END, "aria-label": "End time" });
  const noteI = el("input", { type: "text", id: `bnote-${b.id}`, value: b.note || "", placeholder: "Note (optional) — e.g. first visit!", "aria-label": "Note" });
  startI.addEventListener("focus", () => { typingActive = true; });
  startI.addEventListener("blur", () => { typingActive = false; });
  endI.addEventListener("focus", () => { typingActive = true; });
  endI.addEventListener("blur", () => { typingActive = false; });
  noteI.addEventListener("focus", () => { typingActive = true; });
  noteI.addEventListener("blur", () => { typingActive = false; });

  form.append(
    el("div", { class: "time-row" },
      el("label", { for: `bstart-${b.id}` }, "From", startI),
      el("label", { for: `bend-${b.id}` }, "To", endI)
    ),
    el("label", { for: `bnote-${b.id}` }, "Note", noteI)
  );

  const save = el("button", { type: "button", class: "btn send sm" }, "Save changes");
  save.addEventListener("click", async () => {
    const startTime = startI.value;
    const endTime = endI.value;
    if (!/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime)) { toast("Pick a start and end time."); return; }
    if (endTime < startTime) { toast("End time must be after the start."); return; }
    const res = await call(() => api.updateBooking(b.id, { startTime, endTime, note: noteI.value.trim() }));
    if (res && res.booking) {
      const i = state.bookings.findIndex((x) => x.id === b.id);
      if (i >= 0) state.bookings[i] = res.booking;
      state._editingBooking = "";
      toast("Booking updated.");
      renderTrucks();
    }
  });
  form.append(el("div", { class: "btn-row" }, save));
  return form;
}

// Vendor lookup helpers for the day editor + add row.
function vendorsFor(clientId) {
  return state.vendors
    .filter((v) => v.clientId === clientId && v.active !== false)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}
function vendorCategory(vendorId) {
  const v = state.vendors.find((x) => x.id === vendorId);
  return v ? v.category : "";
}
// Display name for a booking: the registry name wins over the booking's snapshot,
// so a rename (misspelling fix) shows immediately (mirrors the portal).
function vendorNameFor(b) {
  const v = state.vendors.find((x) => x.id === b.vendorId && x.clientId === b.clientId);
  return (v && v.name) || b.vendorName || b.vendorId;
}

// Add-a-truck: autocomplete over the client's registry (a <datalist>), default
// lot hours, with a "+ add a new truck" affordance that upserts then books.
function addTruckRow(clientId, dateISO) {
  const wrap = el("div", { class: "add-truck" });
  wrap.append(el("div", { class: "section-label", style: "margin:18px 0 8px" }, "Add a truck"));

  const vendors = vendorsFor(clientId);
  const listId = `vdl-${dateISO}`;
  const datalist = el("datalist", { id: listId });
  for (const v of vendors) datalist.append(el("option", { value: v.name }));

  const nameI = el("input", { type: "text", id: `add-name-${dateISO}`, list: listId,
    placeholder: "Search trucks or type a new name", "aria-label": "Truck", autocomplete: "off" });
  const startI = el("input", { type: "time", id: `add-start-${dateISO}`, value: LOT_START, "aria-label": "Start time" });
  const endI = el("input", { type: "time", id: `add-end-${dateISO}`, value: LOT_END, "aria-label": "End time" });
  for (const inp of [nameI, startI, endI]) {
    inp.addEventListener("focus", () => { typingActive = true; });
    inp.addEventListener("blur", () => { typingActive = false; });
  }

  wrap.append(datalist);
  wrap.append(el("label", { for: `add-name-${dateISO}` }, "Truck", nameI));
  wrap.append(el("div", { class: "time-row" },
    el("label", { for: `add-start-${dateISO}` }, "From", startI),
    el("label", { for: `add-end-${dateISO}` }, "To", endI)
  ));

  // "+ Add a new truck" panel: appears when the typed name matches no vendor.
  const newPanel = el("div", { class: "new-truck hidden" });
  const catSel = el("select", { id: `add-cat-${dateISO}`, "aria-label": "Category" },
    ...VENDOR_CATEGORIES.map((c) => el("option", { value: c }, c)));
  const priceSel = el("select", { id: `add-price-${dateISO}`, "aria-label": "Price" },
    ...VENDOR_PRICES.map((p) => el("option", { value: p }, p)));
  const taglineI = el("input", { type: "text", id: `add-tag-${dateISO}`, placeholder: "Short tagline (optional)", "aria-label": "Tagline" });
  for (const inp of [catSel, priceSel, taglineI]) {
    inp.addEventListener("focus", () => { typingActive = true; });
    inp.addEventListener("blur", () => { typingActive = false; });
  }
  newPanel.append(
    el("div", { class: "new-truck-hint muted small" }, "New truck — it'll be saved to this client's directory."),
    el("div", { class: "time-row" },
      el("label", { for: `add-cat-${dateISO}` }, "Category", catSel),
      el("label", { for: `add-price-${dateISO}` }, "Price", priceSel)
    ),
    el("label", { for: `add-tag-${dateISO}` }, "Tagline", taglineI)
  );

  // Show the new-truck fields only when the name doesn't match an existing vendor.
  const syncNewPanel = () => {
    const typed = nameI.value.trim().toLowerCase();
    const match = vendors.find((v) => v.name.toLowerCase() === typed);
    newPanel.classList.toggle("hidden", !typed || !!match);
  };
  nameI.addEventListener("input", syncNewPanel);

  wrap.append(newPanel);

  const addBtn = el("button", { type: "button", class: "btn primary block", style: "margin-top:12px" }, "Add to this day");
  addBtn.addEventListener("click", async () => {
    const typed = nameI.value.trim();
    if (!typed) { toast("Pick a truck or type a name first."); nameI.focus(); return; }
    const startTime = startI.value || LOT_START;
    const endTime = endI.value || LOT_END;
    if (endTime < startTime) { toast("End time must be after the start."); return; }

    let vendor = vendors.find((v) => v.name.toLowerCase() === typed.toLowerCase());

    // New truck: register it first, then book it.
    if (!vendor) {
      const vres = await call(() => truckApi.upsertVendor(clientId, {
        name: typed,
        category: catSel.value,
        price: priceSel.value,
        tagline: taglineI.value.trim(),
        active: true,
      }));
      if (!vres || !vres.vendorId) return;
      // The upsert only returns the id; synthesize the row locally so the very next
      // booking + calendar render can resolve its name/category (poll reconciles).
      vendor = {
        id: vres.vendorId, clientId, name: typed, category: catSel.value,
        price: priceSel.value, tagline: taglineI.value.trim(), active: true,
      };
      if (!state.vendors.some((v) => v.id === vendor.id)) state.vendors.push(vendor);
    }

    const res = await call(() => truckApi.addBookings(clientId, [{ vendorId: vendor.id, date: dateISO, startTime, endTime, note: "" }]));
    if (res && Array.isArray(res.ids) && res.ids.length) {
      // Optimistic paint: add the booking locally; the next poll reconciles.
      state.bookings.push({
        id: res.ids[0], clientId, vendorId: vendor.id, vendorName: vendor.name,
        date: dateISO, startTime, endTime, note: "", seriesId: "", status: "scheduled",
      });
      toast(`${vendor.name} added.`);
      nameI.value = "";
      renderTrucks();
    }
  });
  wrap.append(addBtn);

  return wrap;
}

// ===================================================================
// CLIENTS view
// ===================================================================
// ===================================================================
// HISTORY view — one searchable timeline of everything the worker and
// clients did (activity log + threads + drafts + change notes). This is
// how drafting work done on the Mac/VPS stays visible from the phone.
// ===================================================================
const HISTORY_SHOW_MAX = 200;
const HISTORY_KIND_BADGE = {
  ready: "go", done: "go", error: "warn", "change-note": "warn", message: "", draft: "",
};

function renderHistory() {
  const list = $("#history-list");
  const all = flattenHistory(state.requests, state.clients.map((c) => ({ id: c.clientId, name: c.name })));
  const hits = searchHistory(all, state.historyQuery || "");
  $("#count-history").textContent = state.historyQuery && hits.length ? String(hits.length) : "";

  if (!all.length) {
    list.replaceChildren(el("div", { class: "card empty" }, "Nothing recorded yet. Worker activity will show up here."));
    return;
  }
  if (!hits.length) {
    list.replaceChildren(el("div", { class: "card empty" }, `No matches for “${state.historyQuery}”.`));
    return;
  }

  list.replaceChildren(
    ...hits.slice(0, HISTORY_SHOW_MAX).map((h) => {
      const badge = HISTORY_KIND_BADGE[h.kind];
      const card = el("div", { class: "card history-entry", role: "button", tabindex: "0" },
        el("div", { class: "spread" },
          el("div", { class: "row" },
            el("span", { class: "badge" + (badge ? " " + badge : "") }, h.kind),
            el("span", { class: "req-client" }, h.clientName || "—")
          ),
          el("span", { class: "req-when" }, relTime(h.at))
        ),
        el("div", { class: "small", style: "margin-top:6px" }, h.title),
        el("div", { class: "muted small", style: "margin-top:2px" }, h.text)
      );
      // Tap-through: open Requests filtered to this entry's client.
      card.addEventListener("click", () => {
        state.view = "requests";
        state.filterClient = h.clientId || "all";
        saveUiState();
        render();
      });
      return card;
    }),
    hits.length > HISTORY_SHOW_MAX ? el("div", { class: "muted small", style: "text-align:center;padding:8px" }, `Showing the newest ${HISTORY_SHOW_MAX} of ${hits.length} — refine the search to see older entries.`) : null
  );
}

$("#history-search").addEventListener("input", (e) => {
  state.historyQuery = e.target.value;
  renderHistory();
});

function renderClients() {
  const list = $("#clients-list");
  const rows = state.clients.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));

  if (!rows.length) {
    list.replaceChildren(el("div", { class: "card empty" }, "No clients yet. Add your first one below."));
    return;
  }
  list.replaceChildren(...rows.map((c) => clientCard(c)));
}

function clientCard(c) {
  const card = el("div", { class: "card" });

  card.append(el("div", { class: "spread" },
    el("div", { class: "row" },
      brandAvatar(c, c.clientId),
      el("div", {},
        el("div", { class: "req-client" }, c.name || c.clientId),
        el("div", { class: "client-id" }, c.clientId)
      )
    ),
    c.active === false ? el("span", { class: "badge warn" }, "Inactive") : el("span", { class: "badge go" }, "Active")
  ));

  card.append(el("div", { class: "muted small", style: "margin-top:10px" },
    c.brandSlug ? `Brand: ${c.brandSlug}` : "No brand set"));

  // portal link + copy
  // Resolve the portal link relative to the Desk's own URL (sibling dir), so it keeps
  // the GitHub Pages project base path (/nynm-client-hub/). location.origin alone drops
  // it -> a 404 link. Works in both prod and the local mock.
  const portalLink = new URL(`../portal/?c=${encodeURIComponent(c.token || "")}`, location.href).href;
  const linkInput = el("input", { type: "text", readonly: "readonly", value: portalLink, "aria-label": "Portal link" });
  linkInput.addEventListener("focus", () => linkInput.select());

  const copyBtn = el("button", { type: "button", class: "btn sm" }, "Copy link");
  copyBtn.addEventListener("click", async () => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(portalLink);
      } else {
        linkInput.select();
        document.execCommand("copy");
      }
      toast("Portal link copied.");
    } catch {
      linkInput.select();
      toast("Select all and copy the link.");
    }
  });

  card.append(el("div", { class: "linkrow" }, linkInput, copyBtn));
  return card;
}

// ---------- add-client form ----------
$("#client-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const clientId = $("#cl-id").value.trim();
  const name = $("#cl-name").value.trim();
  const brandSlug = $("#cl-brand").value.trim();
  const pin = $("#cl-pin").value.trim();

  if (!clientId || !name) { toast("Client ID and name are both needed."); return; }

  const existing = state.clientById[clientId] || {};
  const payload = {
    clientId,
    name,
    brandSlug,
    pin,
    postizChannels: existing.postizChannels || [],
    siteFolder: existing.siteFolder || "",
    active: existing.active === false ? false : true,
  };

  const res = await call(() => api.upsertClient(payload));
  if (res) {
    toast(existing.clientId ? "Client updated." : "Client added.");
    $("#cl-id").value = "";
    $("#cl-name").value = "";
    $("#cl-brand").value = "";
    $("#cl-pin").value = "";
    await poll(); // pull the fresh client (incl. its generated token) back in
    render();
  }
});

// ===================================================================
// boot
// ===================================================================
loadInitial();
