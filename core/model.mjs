// Client Hub — pure domain logic. No I/O. Shared by the mock server, the worker,
// and mirrored by apps-script/Code.gs. TDD'd in model.test.mjs.

export const REQUEST_TYPES = ["post", "website", "design", "event-promo"];

export const STAGES = [
  "submitted", // client created it
  "queued", // Marshall tapped "Send to Claude"
  "drafting", // worker is building
  "ready", // draft staged, awaiting Marshall
  "changes", // Marshall asked for changes
  "approved", // Marshall approved
  "shipping", // worker is publishing/applying
  "done", // shipped
  "error", // worker failed
];

// stage:action -> next stage
const TRANSITIONS = {
  "submitted:send": "queued",
  "queued:start": "drafting",
  "changes:start": "drafting",
  "error:start": "drafting",
  "drafting:ready": "ready",
  "ready:approve": "approved",
  "ready:requestChanges": "changes",
  "approved:ship": "shipping",
  "shipping:done": "done",
};

export function nextStage(current, action) {
  if (action === "error") return "error"; // any stage may fail
  const next = TRANSITIONS[`${current}:${action}`];
  if (!next) throw new Error(`illegal transition: ${current} --${action}-->`);
  return next;
}

function titleFromDescription(desc) {
  const words = String(desc).trim().split(/\s+/).slice(0, 7);
  let t = words.join(" ");
  if (t.length > 60) t = t.slice(0, 57) + "…";
  return t;
}

export function validateRequestInput(input) {
  const errors = [];
  if (!input || typeof input !== "object") return { ok: false, errors: ["missing input"] };
  const clientId = String(input.clientId || "").trim();
  if (!clientId) errors.push("clientId required");
  const type = String(input.type || "").trim();
  if (!REQUEST_TYPES.includes(type)) errors.push(`type must be one of ${REQUEST_TYPES.join(", ")}`);
  const description = String(input.description || "").trim();
  if (!description) errors.push("description required");
  let attachments = input.attachments == null ? [] : input.attachments;
  if (!Array.isArray(attachments)) errors.push("attachments must be an array");
  if (errors.length) return { ok: false, errors };
  const title = String(input.title || "").trim() || titleFromDescription(description);
  return {
    ok: true,
    errors: [],
    value: {
      clientId,
      type,
      title,
      description,
      attachments: attachments.map((a) => ({
        name: String(a.name || ""),
        url: String(a.url || ""),
        mime: String(a.mime || ""),
      })),
      eventId: String(input.eventId || ""),
    },
  };
}

function isIsoDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s)) && !Number.isNaN(Date.parse(String(s)));
}

export function validateEventInput(input) {
  const errors = [];
  if (!input || typeof input !== "object") return { ok: false, errors: ["missing input"] };
  const clientId = String(input.clientId || "").trim();
  if (!clientId) errors.push("clientId required");
  const title = String(input.title || "").trim();
  if (!title) errors.push("title required");
  const date = String(input.date || "").trim();
  if (!isIsoDate(date)) errors.push("date must be YYYY-MM-DD");
  const time = String(input.time || "").trim(); // optional start time, "HH:MM" 24-hour
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) errors.push("time must be HH:MM (24-hour)");
  const endTime = String(input.endTime || "").trim(); // optional end time, "HH:MM" 24-hour
  if (endTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime)) errors.push("endTime must be HH:MM (24-hour)");
  if (errors.length) return { ok: false, errors };
  return { ok: true, errors: [], value: { clientId, title, date, time, endTime, description: String(input.description || "").trim() } };
}

// Which skill the worker drain should reach for, given the request type + text.
export function routeSkill(type, description = "") {
  const d = String(description).toLowerCase();
  switch (type) {
    case "post":
    case "event-promo":
      return { skill: "branded-social-post", mode: "post" };
    case "website":
      return { skill: "site-edit", mode: "website" };
    case "design":
      if (/\b(photo|photograph|headshot|product shot|realistic|picture of|image of)\b/.test(d))
        return { skill: "imagery", mode: "image" };
      if (/\b(proposal|audit|calendar|one-pager|one pager|invoice|brief|report|sheet)\b/.test(d))
        return { skill: "branded-collateral", mode: "doc" };
      return { skill: "branded-social-post", mode: "graphic" };
    default:
      return { skill: "branded-social-post", mode: "post" };
  }
}

// Notify Marshall when a brand-new request lands, or when one errors.
export function shouldNotify(prevStage, nextStageVal) {
  if (prevStage == null && nextStageVal === "submitted") return true;
  if (nextStageVal === "error") return true;
  return false;
}

export function digestSummary(requests = []) {
  const open = requests.filter((r) => r.stage !== "done");
  const byStage = {};
  for (const r of requests) byStage[r.stage] = (byStage[r.stage] || 0) + 1;
  const lines = open.map((r) => `${r.clientId} · ${r.type} · ${r.stage} · ${r.title || ""}`.trim());
  return { open: open.length, byStage, lines };
}

// Strip secret fields before sending a client object to the portal.
export function publicClient(client = {}) {
  return {
    clientId: client.clientId,
    name: client.name,
    hasPin: !!(client.pin && String(client.pin).length),
  };
}

export function validatePin(client = {}, pin) {
  if (!client.pin || String(client.pin).length === 0) return true;
  return String(pin) === String(client.pin);
}

// What a "Retry / requeue" of an errored request should do. A failure AFTER approval
// (run.phase === "publish": Postiz blip, shipper crash, interrupted publish) still has
// a reviewed, approved draft — requeue it to the SHIP lane (stage "approved", draft
// kept) instead of wiping the creative and burning another drafting run. Anything
// else (draft-phase failures, legacy rows with no phase, or a publish error whose
// draft is somehow gone) conservatively goes back to "queued" for a fresh draft.
// The Desk's Retry button and any worker-side requeue should both use this.
export function planRequeue(request = {}) {
  const run = (request.meta && request.meta.run) || {};
  if (run.phase === "publish" && request.draft) return { stage: "approved" };
  return { stage: "queued", draft: null };
}

// Optimistic merge: overlay patch onto the freshest record, stamp updatedAt.
export function mergePatch(current = {}, patch = {}, nowIso) {
  return { ...current, ...patch, updatedAt: nowIso || new Date().toISOString() };
}

// True if an incoming write is based on a stale read (someone wrote in between).
export function isStale(incomingUpdatedAt, currentUpdatedAt) {
  return Date.parse(incomingUpdatedAt) < Date.parse(currentUpdatedAt);
}
