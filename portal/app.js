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
// Client-facing status scheme: New (gray) -> In progress (blue) -> Ready (green) -> Posted (gray).
const STAGE_LABELS = {
  submitted: "New",
  queued: "In progress",
  drafting: "In progress",
  changes: "In progress",
  ready: "Ready",
  approved: "Ready",
  shipping: "Ready",
  done: "Posted",
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
};

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

/* ---------- view helpers ---------- */

function showView(name) {
  for (const [key, el] of Object.entries(views)) {
    if (!el) continue;
    el.classList.toggle("hidden", key !== name);
  }
}

let toastTimer = null;
function toast(message) {
  if (!toastEl) return;
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

function stageBadge(stage) {
  const label = STAGE_LABELS[stage] || "Submitted";
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

function sortByDateAsc(a, b) {
  return String(a && a.date || "").localeCompare(String(b && b.date || ""));
}

/* ---------- rendering: lists ---------- */

function renderRequests(requests) {
  const list = Array.isArray(requests) ? requests.slice() : [];
  list.sort(sortByCreatedDesc);

  if (list.length === 0) {
    requestsList.innerHTML =
      `<div class="card"><div class="empty">No requests yet. Send your first one above.</div></div>`;
    return;
  }

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
          ${stageBadge(req && req.stage)}
        </div>
        ${threadHtml(req)}
      </div>`;
  }).join("");
}

function renderEvents(events) {
  const list = Array.isArray(events) ? events.slice() : [];
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

/* ---------- rendering: attachment thumbnails ---------- */

function renderThumbs() {
  if (pendingAttachments.length === 0) {
    thumbsEl.classList.add("hidden");
    thumbsEl.innerHTML = "";
    return;
  }
  thumbsEl.classList.remove("hidden");
  thumbsEl.innerHTML = pendingAttachments.map((a) => {
    const mime = a.mime || "";
    if (mime.startsWith("audio/")) {
      return `<div class="thumb thumb-audio" title="${esc(a.name || "voice note")}"><span class="small">voice</span></div>`;
    }
    const isImage = mime.startsWith("image/") && a.url;
    const inner = isImage
      ? `<img class="zoomable" src="${esc(a.url)}" alt="${esc(a.name || "attachment")}" />`
      : `<span class="small">file</span>`;
    return `<div class="thumb" title="${esc(a.name || "")}">${inner}</div>`;
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
      resetRequestForm();
      toast("Request sent. We'll take it from here.");
      await refresh();
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
      resetEventForm();
      toast("Event added to your calendar.");
      await refresh();
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

/* ---------- load / refresh ---------- */

function applyData(data) {
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
}

// Re-fetch the client's data and re-render the lists (used after submits).
async function refresh() {
  try {
    const res = await api.load();
    if (res && res.ok) applyData(res);
  } catch (err) {
    /* keep the current view; a transient refresh failure shouldn't blank the screen */
  }
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
    // Network blip: keep showing cached data rather than dead-ending.
    if (!painted) showView("badlink");
    return;
  }

  // Needs a PIN as a second factor (authoritative — override any cached view).
  if (res && res.status === 401 && res.needPin) {
    showView("pin");
    setTimeout(() => $("pin-input") && $("pin-input").focus(), 50);
    return;
  }

  // Bad / unknown link. If we have cached data, this is far more likely a transient
  // backend hiccup than a revoked token — keep the client on their data instead of
  // flashing a scary "invalid link" screen.
  if (!res || res.status === 403 || !res.ok) {
    if (!painted) showView("badlink");
    return;
  }

  // Good — persist token, cache the fresh payload, and reconcile the view.
  rememberAccess();
  if (DATA_CACHE_KEY) writeDataCache(safeLocalStorage(), DATA_CACHE_KEY, res);
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
    errorEl.classList.add("hidden");
    applyData(res);
    showView("app");
    return;
  }

  // Still needs PIN (wrong one) or unauthorized -> show inline error, stay on PIN.
  if (res && (res.needPin || res.status === 401)) {
    errorEl.classList.remove("hidden");
    input.value = "";
    input.focus();
    // reset api back to base token so a fresh attempt re-prompts cleanly
    api = portalApi(token, pin);
    return;
  }

  // Anything else (bad link) -> friendly dead end.
  showView("badlink");
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

// Tap an attachment preview to view it full size.
thumbsEl.addEventListener("click", (e) => {
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
  try {
    const res = await api.message(id, text);
    if (res && res.ok) { toast("Message sent."); await refresh(); }
    else { toast("That didn't send. Please try again."); btn.disabled = false; }
  } catch (err) {
    toast("That didn't send. Please try again."); btn.disabled = false;
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
    reqDesc.value = idea.postIdea || "";
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

// Default selection + initial load.
selectType("post");

if (!token) {
  // No ?c= token at all -> can't load anything.
  showView("badlink");
} else {
  start();
}
