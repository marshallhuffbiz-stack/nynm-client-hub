// NYNM Client Portal — client-facing PWA.
// Plain ES module, no build step. Talks to the shared API client.
import { portalApi, fileToPayload } from "../shared/api.js";

/* ---------- token + api ---------- */

const params = new URLSearchParams(location.search);
const token = params.get("c") || "";
let pin = "";
let api = portalApi(token);

/* ---------- element refs ---------- */

const $ = (id) => document.getElementById(id);

const views = {
  loading: $("view-loading"),
  badlink: $("view-badlink"),
  pin: $("view-pin"),
  app: $("view-app"),
};

const clientNameEl = $("client-name");

const typeChips = $("type-chips");
const requestForm = $("request-form");
const eventForm = $("event-form");

const reqTitle = $("req-title");
const reqDesc = $("req-desc");
const reqDescLabel = $("req-desc-label");
const reqFiles = $("req-files");
const reqSubmit = $("req-submit");
const thumbsEl = $("thumbs");
const uploadStatus = $("upload-status");

const evtTitle = $("evt-title");
const evtDate = $("evt-date");
const evtDesc = $("evt-desc");
const evtSubmit = $("evt-submit");

const requestsList = $("requests-list");
const eventsList = $("events-list");

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
};

// stage -> { label, badge color class }
const STAGE_LABELS = {
  submitted: "Submitted",
  queued: "Queued",
  drafting: "In progress",
  ready: "Ready",
  changes: "Revising",
  approved: "Approved",
  shipping: "Publishing",
  done: "Done",
};
const STAGE_BADGE = {
  submitted: "bone",
  queued: "bone",
  drafting: "warn",
  changes: "warn",
  ready: "send",
  approved: "go",
  shipping: "go",
  done: "go",
};

const TYPE_LABELS = {
  post: "Post",
  website: "Website fix",
  design: "Design",
  "event-promo": "Event promo",
  event: "Event",
};

/* ---------- state ---------- */

let selectedType = "post";
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
      `<div class="card"><div class="empty">No requests yet. Submit your first one above.</div></div>`;
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
      </div>`;
  }).join("");
}

function renderEvents(events) {
  const list = Array.isArray(events) ? events.slice() : [];
  list.sort(sortByDateAsc);

  if (list.length === 0) {
    eventsList.innerHTML =
      `<div class="card"><div class="empty">No events on the calendar yet. Add one above to plan ahead.</div></div>`;
    return;
  }

  eventsList.innerHTML = list.map((evt) => {
    const title = esc((evt && evt.title) || "Event");
    const date = formatDate(evt && evt.date);
    const desc = (evt && evt.description) ? esc(evt.description) : "";
    return `
      <div class="card">
        <div class="evt">
          <div class="evt-title">${title}</div>
          ${date ? `<div class="evt-date">${date}</div>` : ""}
          ${desc ? `<div class="evt-desc">${desc}</div>` : ""}
        </div>
      </div>`;
  }).join("");
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
    const isImage = (a.mime || "").startsWith("image/") && a.url;
    const inner = isImage
      ? `<img src="${esc(a.url)}" alt="${esc(a.name || "attachment")}" />`
      : `<span class="small">file</span>`;
    return `<div class="thumb" title="${esc(a.name || "")}">${inner}</div>`;
  }).join("");
}

/* ---------- type selection ---------- */

function selectType(type) {
  selectedType = type;

  // Toggle active chip state.
  for (const chip of typeChips.querySelectorAll(".chip")) {
    const active = chip.dataset.type === type;
    chip.classList.toggle("active", active);
    chip.setAttribute("aria-selected", active ? "true" : "false");
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
  reqTitle.value = "";
  reqDesc.value = "";
  reqFiles.value = "";
  pendingAttachments = [];
  uploadingCount = 0;
  uploadStatus.textContent = "";
  renderThumbs();
}

function resetEventForm() {
  evtTitle.value = "";
  evtDate.value = "";
  evtDesc.value = "";
}

/* ---------- upload on selection ---------- */

async function onFilesPicked() {
  const files = Array.from(reqFiles.files || []);
  if (files.length === 0) return;

  // Allow re-picking more later: clear the input now so the same file can be re-added.
  reqFiles.value = "";

  uploadingCount += files.length;
  updateUploadStatus();

  for (const file of files) {
    try {
      const payload = await fileToPayload(file);
      const res = await api.upload(payload);
      if (res && res.ok && res.url) {
        pendingAttachments.push({
          name: res.name || file.name,
          url: res.url,
          mime: res.mime || file.type || "",
        });
        renderThumbs();
      } else {
        toast("A photo didn't upload. Try again.");
      }
    } catch (err) {
      toast("A photo didn't upload. Try again.");
    } finally {
      uploadingCount = Math.max(0, uploadingCount - 1);
      updateUploadStatus();
    }
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

async function submitRequest(event) {
  event.preventDefault();
  if (busy) return;

  const description = reqDesc.value.trim();
  if (!description) {
    toast("Add a short description so we know what you need.");
    reqDesc.focus();
    return;
  }
  if (uploadingCount > 0) {
    toast("Hang on — photos are still uploading.");
    return;
  }

  setBusy(true, reqSubmit, "Sending…");
  try {
    const res = await api.submit({
      type: selectedType,
      title: reqTitle.value.trim(),
      description,
      attachments: pendingAttachments.slice(),
    });
    if (res && res.ok) {
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
  document.title = `${name} — NYNM Portal`;
  renderRequests(data && data.requests);
  renderEvents(data && data.events);
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
  showView("loading");

  let res;
  try {
    res = await api.load();
  } catch (err) {
    showView("badlink");
    return;
  }

  // Needs a PIN as a second factor.
  if (res && res.status === 401 && res.needPin) {
    showView("pin");
    setTimeout(() => $("pin-input") && $("pin-input").focus(), 50);
    return;
  }

  // Bad / unknown link.
  if (!res || res.status === 403 || !res.ok) {
    showView("badlink");
    return;
  }

  // Good.
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
  const chip = e.target.closest(".chip");
  if (chip && chip.dataset.type) selectType(chip.dataset.type);
});
requestForm.addEventListener("submit", submitRequest);
eventForm.addEventListener("submit", submitEvent);
reqFiles.addEventListener("change", onFilesPicked);
$("view-pin").addEventListener("submit", onPinSubmit);

// Default selection + initial load.
selectType("post");

if (!token) {
  // No ?c= token at all -> can't load anything.
  showView("badlink");
} else {
  start();
}
