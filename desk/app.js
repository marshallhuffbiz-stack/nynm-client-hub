// Relay Desk — Marshall's internal control panel for all client requests.
// Plain ES module. Talks to the shared API client (mock locally, Apps Script in prod).
import { deskApi } from "../shared/api.js";
import { API_MODE } from "../shared/config.js";
import { openLightbox, makeZoomable } from "../shared/lightbox.js";
import { resolveAccess, persistAccess, DESK_TOKEN_KEY } from "../shared/token.js";
import { installLaunchManifest } from "../shared/pwa.js";

// Trash glyph for the per-request delete control (inline SVG, no icon font / emoji).
const TRASH_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
  '<path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>' +
  '<path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/><path d="M10 11v6M14 11v6"/></svg>';

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
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return { main: iso || "Date to be set", yr: "" };
  const d = new Date(t);
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
  error: { label: "Needs attention", cls: "warn" },
};
function stageMeta(s) { return STAGE_META[s] || { label: s || "·", cls: "bone" }; }

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
  clientById: {},
  filterStage: "all",
  filterClient: "all",
  // dirty comment text the user typed but hasn't saved, keyed by request id
  draftComments: {},
};

let isBusy = false; // a mutation is in flight — pause polling/re-render races
let typingActive = false; // a comment box currently has focus

function setBusy(v) { isBusy = v; }

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
  let res;
  try { res = await api.load(); }
  catch { res = { ok: false, error: "network" }; }
  if (!res || res.status === 403 || res.ok === false) return showBadToken();
  rememberAccess();
  ingest(res);
  showApp();
  render();
}

function ingest(res) {
  state.clients = (Array.isArray(res.clients) ? res.clients : []).filter((c) => !HIDDEN_CLIENTS.has(c.clientId));
  state.requests = (Array.isArray(res.requests) ? res.requests : []).filter((r) => !HIDDEN_CLIENTS.has(r.clientId));
  state.events = (Array.isArray(res.events) ? res.events : []).filter((e) => !HIDDEN_CLIENTS.has(e.clientId));
  state.clientById = {};
  for (const c of state.clients) state.clientById[c.clientId] = c;
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
  let res;
  try { res = await api.load(); }
  catch { return; } // transient; try again next tick
  if (!res || res.status === 403 || res.ok === false) return;
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
  // counts
  const openReq = state.requests.filter((r) => r.stage !== "done").length;
  const unpromoted = state.events.filter((e) => !e.promoted).length;
  $("#count-requests").textContent = openReq ? String(openReq) : "";
  $("#count-events").textContent = unpromoted ? String(unpromoted) : "";
  $("#count-clients").textContent = state.clients.length ? String(state.clients.length) : "";

  // tab active states
  for (const tab of document.querySelectorAll("#tabs .tab")) {
    const on = tab.dataset.view === state.view;
    tab.classList.toggle("active", on);
    tab.setAttribute("aria-selected", on ? "true" : "false");
  }
  $("#panel-requests").classList.toggle("hidden", state.view !== "requests");
  $("#panel-events").classList.toggle("hidden", state.view !== "events");
  $("#panel-clients").classList.toggle("hidden", state.view !== "clients");

  if (state.view === "requests") renderRequests();
  else if (state.view === "events") renderEvents();
  else if (state.view === "clients") renderClients();
}

// ---------- tab switching ----------
$("#tabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (!tab) return;
  state.view = tab.dataset.view;
  render();
});

// ===================================================================
// REQUESTS view
// ===================================================================
function renderFilters() {
  // stage chips
  const sc = $("#stage-chips");
  sc.replaceChildren(
    ...STAGE_FILTERS.map((f) =>
      el("button", {
        type: "button",
        class: "chip sm" + (state.filterStage === f.key ? " active" : ""),
        onclick: () => { state.filterStage = f.key; renderRequests(); },
      }, f.label)
    )
  );

  // client chips (only when more than one client exists)
  const cc = $("#client-chips");
  if (state.clients.length <= 1) {
    cc.replaceChildren();
  } else {
    const chips = [
      el("button", {
        type: "button",
        class: "chip sm" + (state.filterClient === "all" ? " active" : ""),
        onclick: () => { state.filterClient = "all"; renderRequests(); },
      }, "Everyone"),
      ...state.clients.map((c) =>
        el("button", {
          type: "button",
          class: "chip sm" + (state.filterClient === c.clientId ? " active" : ""),
          onclick: () => { state.filterClient = c.clientId; renderRequests(); },
        }, c.name)
      ),
    ];
    cc.replaceChildren(...chips);
  }
}

function filteredRequests() {
  const f = STAGE_FILTERS.find((x) => x.key === state.filterStage) || STAGE_FILTERS[0];
  return state.requests
    .filter((r) => (f.stages ? f.stages.includes(r.stage) : true))
    .filter((r) => (state.filterClient === "all" ? true : r.clientId === state.filterClient))
    .slice()
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
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

  const card = el("div", {
    class: "card" + (isDone ? " is-done" : ""),
    "data-req-id": r.id,
    "data-updated-at": r.updatedAt || "",
  });

  // header
  const head = el("div", { class: "req-head" },
    brandAvatar(cl, r.clientId),
    el("div", { class: "req-headtext" },
      el("div", { class: "req-client" }, clientName(r.clientId)),
      el("div", { class: "req-badges" },
        el("span", { class: "badge bone" }, typeLabel(r.type)),
        el("span", { class: `badge ${sm.cls}` }, sm.label),
        el("span", { class: "req-when" }, relTime(r.createdAt))
      )
    ),
    deleteRequestButton(r)
  );
  card.append(head);

  if (!isDone) {
    if (r.title) card.append(el("div", { class: "req-title" }, r.title));
    if (r.description) card.append(el("div", { class: "req-desc" }, r.description));

    // attachments
    const atts = Array.isArray(r.attachments) ? r.attachments.filter((a) => a && a.url) : [];
    if (atts.length) {
      card.append(
        el("div", { class: "req-thumbs" },
          ...atts.map((a) => {
            if ((a.mime || "").startsWith("audio/")) {
              return el("audio", { class: "att-audio", controls: "controls", preload: "none", src: a.url });
            }
            const full = driveEmbed(a.url, "w2000");
            const link = el("a", { class: "thumb zoomable", href: full, target: "_blank", rel: "noopener", title: a.name || "" },
              el("img", { src: driveEmbed(a.url, "w1200"), alt: a.name || "attachment", loading: "lazy" }));
            link.addEventListener("click", (e) => { e.preventDefault(); openLightbox(full, a.name || "attachment"); });
            return link;
          })
        )
      );
    }
  }

  card.append(actionArea(r));
  card.append(threadSection(r));
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
  return el("div", { class: "act" },
    el("div", { class: "statusline go" }, el("span", { class: "dot" }), document.createTextNode(txt))
  );
}

function errorActions(r) {
  const wrap = el("div", { class: "act stack" });
  const msg = (r.meta && r.meta.run && r.meta.run.error) || "Something went wrong while building this.";
  wrap.append(el("div", { class: "notebox" }, el("strong", {}, "Error: "), document.createTextNode(msg)));
  const retry = el("button", { type: "button", class: "btn ghost sm" }, "Retry");
  retry.addEventListener("click", async () => {
    // Re-queue — NOT action:"start", which maps error->drafting, a stage the worker
    // ignores (it only picks up "queued"), so the request would strand. Clearing
    // run.error stops the Desk showing the stale failure once it's back in the queue.
    const meta = { ...(r.meta || {}), run: { ...((r.meta && r.meta.run) || {}), error: "" } };
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
      document.createTextNode("Didn't post to " + run.failures.map((f) => f.channel).join(", ") + " — handle those manually.")));
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
    if (res) { applyRequest(res.request); toast(isSocial ? "Approved — publishing." : "Approved."); render(); }
  });

  const changes = el("button", { type: "button", class: "btn ghost" }, "Request changes");
  changes.addEventListener("click", async () => {
    const note = window.prompt("What should change?");
    if (note == null) return;
    const trimmed = note.trim();
    if (!trimmed) { toast("Add a short note so Claude knows what to change."); return; }
    const res = await call(() => api.update(r.id, { action: "requestChanges", changeNote: trimmed }));
    if (res) { applyRequest(res.request); toast("Sent back for changes."); render(); }
  });

  wrap.append(el("div", { class: "btn-row" }, approve, changes));
  return wrap;
}

// ===================================================================
// EVENTS view
// ===================================================================
function renderEvents() {
  const list = $("#events-list");
  const rows = state.events.slice().sort((a, b) => Date.parse(a.date || 0) - Date.parse(b.date || 0));

  if (!rows.length) {
    list.replaceChildren(el("div", { class: "card empty" }, "No events yet. Clients add these from their portal."));
    return;
  }

  list.replaceChildren(...rows.map((e) => eventCard(e)));
}

function eventCard(e) {
  const d = fmtEventDate(e.date);
  const startT = fmtTime(e.time);
  const endT = fmtTime(e.endTime);
  const timeText = startT ? (endT ? `${startT} – ${endT}` : startT) : "";
  const card = el("div", { class: "card" });

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
// CLIENTS view
// ===================================================================
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
