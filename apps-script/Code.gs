/**
 * Client Hub — PRODUCTION backend (Google Apps Script, container-bound to the Sheet).
 *
 * This file is a hand-port of the local mock server. It EXACTLY mirrors the HTTP
 * contract of `mock-server/server.mjs` and the domain logic of `core/model.mjs`
 * (which it cannot import — GAS has no ES modules, so the equivalents are
 * re-implemented here as plain functions).
 *
 * Datastore: the bound spreadsheet (SpreadsheetApp.getActiveSpreadsheet()),
 *   three tabs — Clients / Requests / Events — header row = field names.
 *   JSON-valued cells (attachments, postizChannels, draft, meta) are stored as
 *   JSON strings and (de)serialized at the boundary. Booleans stored TRUE/FALSE.
 *
 * Transport note vs. the mock: a GAS web app always replies HTTP 200, so the real
 *   outcome is encoded in the JSON body. Every response carries the same
 *   `ok`/`error`/`errors`/`needPin` fields as the mock PLUS a `status` field
 *   holding the intended HTTP code (200/400/401/403/404/405/409/500) so the
 *   browser client can key off it in live mode. See README/summary follow-up for
 *   the one-line shared/api.js change required to read body.status in live mode.
 */

/* ============================ Constants ============================ */

var SHEET_CLIENTS = "Clients";
var SHEET_REQUESTS = "Requests";
var SHEET_EVENTS = "Events";

var COLS_CLIENTS = [
  "clientId", "name", "token", "pin", "brandSlug",
  "postizChannels", "siteFolder", "active", "createdAt", "updatedAt"
];
var COLS_REQUESTS = [
  "id", "clientId", "type", "title", "description", "attachments",
  "eventId", "stage", "comment", "scheduledFor", "draft", "changeNote",
  "createdAt", "updatedAt", "meta"
];
var COLS_EVENTS = [
  "eventId", "clientId", "title", "date", "description",
  "promoted", "requestId", "createdAt", "updatedAt", "time"
];

// Per-tab: which columns are JSON-encoded in the cell, and which are booleans.
var JSON_FIELDS = {
  Clients: ["postizChannels"],
  Requests: ["attachments", "draft", "meta"],
  Events: []
};
var BOOL_FIELDS = {
  Clients: ["active"],
  Requests: [],
  Events: ["promoted"]
};

// Mirror of core/model.mjs REQUEST_TYPES.
var REQUEST_TYPES = ["post", "website", "design", "event-promo"];

// Mirror of core/model.mjs STAGES (documentation / reference).
var STAGES = [
  "submitted", "queued", "drafting", "ready", "changes",
  "approved", "shipping", "done", "error"
];

// Mirror of core/model.mjs TRANSITIONS  (stage:action -> next stage).
var TRANSITIONS = {
  "submitted:send": "queued",
  "queued:start": "drafting",
  "changes:start": "drafting",
  "error:start": "drafting",
  "drafting:ready": "ready",
  "ready:approve": "approved",
  "ready:requestChanges": "changes",
  "approved:ship": "shipping",
  "shipping:done": "done"
};

var PROP_ADMIN_TOKEN = "ADMIN_TOKEN";
var PROP_UPLOAD_FOLDER_ID = "UPLOAD_FOLDER_ID";
var UPLOAD_FOLDER_NAME = "Client Hub Uploads";

/* ============================ Small helpers ============================ */

function now_() {
  // Mirror mock: const now = () => new Date().toISOString();
  return new Date().toISOString();
}

// req_<base36 time>_<hex rand>  — mirrors core/ids.mjs genId().
function genId_(prefix) {
  prefix = prefix || "id";
  var t = Date.now().toString(36);
  var r = "";
  while (r.length < 8) {
    r += Math.floor(Math.random() * 16).toString(16);
  }
  r = r.slice(0, 8); // 4 random bytes => 8 hex chars
  return prefix + "_" + t + "_" + r;
}

// url-safe alphanumeric token, >= len (default 24) — mirrors core/ids.mjs genToken().
function genToken_(len) {
  len = len || 24;
  var s = "";
  while (s.length < len) {
    // Utilities.getUuid() gives strong entropy; strip non-alphanumerics.
    s += Utilities.getUuid().replace(/[^a-zA-Z0-9]/g, "");
  }
  return s.slice(0, Math.max(len, 24));
}

function isIsoDate_(s) {
  s = String(s);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  var t = Date.parse(s);
  return !isNaN(t);
}

// mirror titleFromDescription() in core/model.mjs
function titleFromDescription_(desc) {
  var words = String(desc).trim().split(/\s+/).slice(0, 7);
  var t = words.join(" ");
  if (t.length > 60) t = t.slice(0, 57) + "…"; // … ellipsis, matches mock
  return t;
}

/* ============================ Spreadsheet access layer ============================ */

// Standalone deploy: set SHEET_ID to the target sheet's id and the script opens
// it by id. Leave SHEET_ID empty ("") for a container-bound deploy.
var SHEET_ID = "13doR_3WcCSzsGBa6Emd5zHnMiY7leDyJrkJaT0Zoew0";
function ss_() {
  return SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
}

function colsFor_(sheetName) {
  if (sheetName === SHEET_CLIENTS) return COLS_CLIENTS;
  if (sheetName === SHEET_REQUESTS) return COLS_REQUESTS;
  if (sheetName === SHEET_EVENTS) return COLS_EVENTS;
  throw new Error("unknown sheet " + sheetName);
}

function getOrCreateSheet_(name, cols) {
  var s = ss_().getSheetByName(name);
  if (!s) {
    s = ss_().insertSheet(name);
  }
  // Ensure header row exactly matches cols.
  var firstRow = s.getRange(1, 1, 1, cols.length).getValues()[0];
  var headerOk = true;
  for (var i = 0; i < cols.length; i++) {
    if (String(firstRow[i]) !== cols[i]) { headerOk = false; break; }
  }
  if (!headerOk) {
    s.getRange(1, 1, 1, cols.length).setValues([cols]);
    s.setFrozenRows(1);
  }
  return s;
}

// Decode a raw cell value into the in-memory JS value for `field` on `sheetName`.
function decodeCell_(sheetName, field, raw) {
  if (BOOL_FIELDS[sheetName].indexOf(field) >= 0) {
    if (raw === true) return true;
    if (raw === false) return false;
    var sv = String(raw).trim().toUpperCase();
    if (sv === "TRUE") return true;
    if (sv === "FALSE") return false;
    return raw === "" ? false : !!raw;
  }
  if (JSON_FIELDS[sheetName].indexOf(field) >= 0) {
    if (raw === "" || raw === null || raw === undefined) {
      // draft default is null in the mock; arrays default to []; meta to {}.
      if (field === "draft") return null;
      if (field === "attachments" || field === "postizChannels") return [];
      if (field === "meta") return {};
      return null;
    }
    try { return JSON.parse(String(raw)); } catch (e) { return null; }
  }
  // Plain scalar/string field. Keep "" as "".
  return raw === null || raw === undefined ? "" : raw;
}

// Encode an in-memory JS value back into the cell representation for storage.
function encodeCell_(sheetName, field, val) {
  if (BOOL_FIELDS[sheetName].indexOf(field) >= 0) {
    return val === true || String(val).toUpperCase() === "TRUE";
  }
  if (JSON_FIELDS[sheetName].indexOf(field) >= 0) {
    if (val === undefined) val = (field === "draft" ? null : (field === "meta" ? {} : []));
    return JSON.stringify(val === undefined ? null : val);
  }
  if (val === null || val === undefined) return "";
  return val;
}

// Read an entire tab as an array of row objects (1-based sheet row tracked in __row).
function readAll_(sheetName) {
  var cols = colsFor_(sheetName);
  var sheet = getOrCreateSheet_(sheetName, cols);
  var lastRow = sheet.getLastRow();
  var out = [];
  if (lastRow < 2) return out;
  var values = sheet.getRange(2, 1, lastRow - 1, cols.length).getValues();
  for (var r = 0; r < values.length; r++) {
    var row = values[r];
    // Skip fully-empty rows.
    var allEmpty = true;
    for (var k = 0; k < row.length; k++) {
      if (String(row[k]) !== "") { allEmpty = false; break; }
    }
    if (allEmpty) continue;
    var obj = {};
    for (var c = 0; c < cols.length; c++) {
      obj[cols[c]] = decodeCell_(sheetName, cols[c], row[c]);
    }
    obj.__row = r + 2; // actual sheet row index
    out.push(obj);
  }
  return out;
}

// Append a new record object to a tab.
function appendRow_(sheetName, obj) {
  var cols = colsFor_(sheetName);
  var sheet = getOrCreateSheet_(sheetName, cols);
  var rowVals = [];
  for (var c = 0; c < cols.length; c++) {
    rowVals.push(encodeCell_(sheetName, cols[c], obj[cols[c]]));
  }
  sheet.appendRow(rowVals);
}

// Overwrite an existing record at its __row with the merged object.
function writeRow_(sheetName, rowIndex, obj) {
  var cols = colsFor_(sheetName);
  var sheet = getOrCreateSheet_(sheetName, cols);
  var rowVals = [];
  for (var c = 0; c < cols.length; c++) {
    rowVals.push(encodeCell_(sheetName, cols[c], obj[cols[c]]));
  }
  sheet.getRange(rowIndex, 1, 1, cols.length).setValues([rowVals]);
}

/* ============================ Validation (mirrors core/model.mjs) ============================ */

function validateRequestInput_(input) {
  var errors = [];
  if (!input || typeof input !== "object") return { ok: false, errors: ["missing input"] };
  var clientId = String(input.clientId || "").trim();
  if (!clientId) errors.push("clientId required");
  var type = String(input.type || "").trim();
  if (REQUEST_TYPES.indexOf(type) < 0) errors.push("type must be one of " + REQUEST_TYPES.join(", "));
  var description = String(input.description || "").trim();
  if (!description) errors.push("description required");
  var attachments = (input.attachments == null) ? [] : input.attachments;
  if (!isArray_(attachments)) errors.push("attachments must be an array");
  if (errors.length) return { ok: false, errors: errors };
  var title = String(input.title || "").trim() || titleFromDescription_(description);
  return {
    ok: true,
    errors: [],
    value: {
      clientId: clientId,
      type: type,
      title: title,
      description: description,
      attachments: attachments.map(function (a) {
        a = a || {};
        return { name: String(a.name || ""), url: String(a.url || ""), mime: String(a.mime || "") };
      }),
      eventId: String(input.eventId || "")
    }
  };
}

function validateEventInput_(input) {
  var errors = [];
  if (!input || typeof input !== "object") return { ok: false, errors: ["missing input"] };
  var clientId = String(input.clientId || "").trim();
  if (!clientId) errors.push("clientId required");
  var title = String(input.title || "").trim();
  if (!title) errors.push("title required");
  var date = String(input.date || "").trim();
  if (!isIsoDate_(date)) errors.push("date must be YYYY-MM-DD");
  var time = String(input.time || "").trim(); // optional start time, "HH:MM" 24-hour
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) errors.push("time must be HH:MM (24-hour)");
  if (errors.length) return { ok: false, errors: errors };
  return {
    ok: true,
    errors: [],
    value: { clientId: clientId, title: title, date: date, time: time, description: String(input.description || "").trim() }
  };
}

// mirror nextStage(): throws on illegal transition; "error" always allowed.
function nextStage_(current, action) {
  if (action === "error") return "error";
  var next = TRANSITIONS[current + ":" + action];
  if (!next) throw new Error("illegal transition: " + current + " --" + action + "-->");
  return next;
}

// mirror mergePatch(): overlay patch onto current, stamp updatedAt.
function mergePatch_(current, patch, nowIso) {
  var out = {};
  var k;
  for (k in current) { if (current.hasOwnProperty(k)) out[k] = current[k]; }
  for (k in patch) { if (patch.hasOwnProperty(k)) out[k] = patch[k]; }
  out.updatedAt = nowIso || now_();
  return out;
}

// mirror publicClient(): strip secrets before sending to the portal.
function publicClient_(client) {
  client = client || {};
  return {
    clientId: client.clientId,
    name: client.name,
    hasPin: !!(client.pin && String(client.pin).length)
  };
}

// mirror validatePin(): true if no pin set, else exact string match.
function validatePin_(client, pin) {
  client = client || {};
  if (!client.pin || String(client.pin).length === 0) return true;
  return String(pin) === String(client.pin);
}

function isArray_(x) {
  return Object.prototype.toString.call(x) === "[object Array]";
}

/* ============================ JSON output helper ============================ */

// Mirror of mock `send(res, code, obj)`. GAS always returns HTTP 200, so the
// intended status is carried in body.status for the live client to key off.
function json_(code, obj) {
  var body = {};
  var k;
  for (k in obj) { if (obj.hasOwnProperty(k)) body[k] = obj[k]; }
  body.status = code;
  return ContentService
    .createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ============================ Properties / token ============================ */

function getAdminToken_() {
  return PropertiesService.getScriptProperties().getProperty(PROP_ADMIN_TOKEN);
}

// Constant-time string compare for the admin token (the master key). Avoids leaking
// it byte-by-byte via the early-return timing of ===. Length check first is acceptable.
function safeEquals_(a, b) {
  a = String(a == null ? "" : a);
  b = String(b == null ? "" : b);
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= (a.charCodeAt(i) ^ b.charCodeAt(i));
  return diff === 0;
}

function getUploadFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(PROP_UPLOAD_FOLDER_ID);
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* fall through, recreate */ }
  }
  var folder = DriveApp.createFolder(UPLOAD_FOLDER_NAME);
  props.setProperty(PROP_UPLOAD_FOLDER_ID, folder.getId());
  return folder;
}

/* ============================ doGet ============================ */

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    var admin = p.admin;
    // GET client token comes in as ?client= (Google's web-app frontend reserves
    // the single-letter param ?c=, returning a 400 before the script runs).
    var c = p.client != null && p.client !== "" ? p.client : p.c;

    if (admin != null && admin !== undefined && admin !== "") {
      if (!safeEquals_(admin, getAdminToken_())) {
        return json_(403, { ok: false, error: "bad admin token" });
      }
      return json_(200, {
        ok: true,
        clients: readAll_(SHEET_CLIENTS).map(stripRowMeta_),
        requests: readAll_(SHEET_REQUESTS).map(stripRowMeta_),
        events: readAll_(SHEET_EVENTS).map(stripRowMeta_)
      });
    }

    if (c != null && c !== undefined && c !== "") {
      var clients = readAll_(SHEET_CLIENTS);
      var client = null;
      for (var i = 0; i < clients.length; i++) {
        if (clients[i].token === c && clients[i].active !== false) { client = clients[i]; break; }
      }
      if (!client) return json_(403, { ok: false, error: "bad client link" });
      if (!validatePin_(client, p.pin)) {
        return json_(401, { ok: false, error: "pin required", needPin: true });
      }
      var reqs = readAll_(SHEET_REQUESTS).filter(function (r) { return r.clientId === client.clientId; });
      var evs = readAll_(SHEET_EVENTS).filter(function (ev) { return ev.clientId === client.clientId; });
      return json_(200, {
        ok: true,
        client: publicClient_(client),
        requests: reqs.map(stripRowMeta_),
        events: evs.map(stripRowMeta_)
      });
    }

    // No recognized query param. Mirror: nothing matched -> generic error.
    return json_(400, { ok: false, error: "missing query (?client= or ?admin=)" });
  } catch (err) {
    return json_(500, { ok: false, error: String((err && err.message) || err) });
  }
}

// Remove the internal __row bookkeeping key before sending records over the wire.
function stripRowMeta_(obj) {
  var out = {};
  for (var k in obj) {
    if (obj.hasOwnProperty(k) && k !== "__row") out[k] = obj[k];
  }
  return out;
}

/* ============================ doPost ============================ */

function doPost(e) {
  try {
    var body;
    try {
      body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    } catch (parseErr) {
      body = {};
    }
    var action = body.action;

    // Auth (read tokens up front, same as mock data0 read).
    var adminToken = getAdminToken_();
    var adminOk = !!(body.admin && safeEquals_(body.admin, adminToken));

    // Client lookup mirrors the mock POST path exactly: find by token, NO active
    // filter here (the mock's POST handler does not check active — only GET does).
    var clientForAuth = null;
    if (body.c) {
      var allClients = readAll_(SHEET_CLIENTS);
      for (var i = 0; i < allClients.length; i++) {
        if (allClients[i].token === body.c) { clientForAuth = allClients[i]; break; }
      }
    }

    if (["updateRequest", "promoteEvent", "upsertClient", "deleteRequest"].indexOf(action) >= 0 && !adminOk) {
      return json_(403, { ok: false, error: "admin required" });
    }
    if (["submitRequest", "addEvent", "uploadAttachment", "postMessage"].indexOf(action) >= 0 && !clientForAuth && !adminOk) {
      return json_(403, { ok: false, error: "client link required" });
    }

    // All writes serialized under the script lock (the GAS analog of the mock's
    // file lock / store.tx read-merge-write transaction).
    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(30000);
    } catch (lockErr) {
      return json_(409, { ok: false, error: "busy, try again" });
    }

    try {
      var result;
      switch (action) {
        case "submitRequest":
          result = handleSubmitRequest_(body, clientForAuth);
          break;
        case "addEvent":
          result = handleAddEvent_(body, clientForAuth);
          break;
        case "uploadAttachment":
          result = handleUploadAttachment_(body);
          break;
        case "updateRequest":
          result = handleUpdateRequest_(body);
          break;
        case "promoteEvent":
          result = handlePromoteEvent_(body);
          break;
        case "upsertClient":
          result = handleUpsertClient_(body);
          break;
        case "deleteRequest":
          result = handleDeleteRequest_(body);
          break;
        case "postMessage":
          result = handlePostMessage_(body, clientForAuth);
          break;
        default:
          result = { code: 400, obj: { ok: false, error: "unknown action" } };
      }
      return json_(result.code, result.obj);
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return json_(500, { ok: false, error: String((err && err.message) || err) });
  }
}

/* ============================ POST action handlers (mirror mock switch) ============================ */

// Hard-delete a request row (admin only). Lets tests / accidental submissions be
// removed from the history. Mirrors the mock's data.requests.splice().
function handleDeleteRequest_(body) {
  var requests = readAll_(SHEET_REQUESTS);
  var rec = null;
  for (var i = 0; i < requests.length; i++) {
    if (requests[i].id === body.id) { rec = requests[i]; break; }
  }
  if (!rec) return { code: 404, obj: { ok: false, error: "not found" } };
  var sheet = getOrCreateSheet_(SHEET_REQUESTS, colsFor_(SHEET_REQUESTS));
  sheet.deleteRow(rec.__row);
  return { code: 200, obj: { ok: true, id: body.id, deleted: true } };
}

// Append a message to a request's two-way thread (client <-> team). A client may
// only post to its own request; admin may post to any. Stored in meta.thread (JSON).
function handlePostMessage_(body, client) {
  var adminOk = !!(body.admin && safeEquals_(body.admin, getAdminToken_()));
  var requests = readAll_(SHEET_REQUESTS);
  var rec = null;
  for (var i = 0; i < requests.length; i++) {
    if (requests[i].id === body.id) { rec = requests[i]; break; }
  }
  if (!rec) return { code: 404, obj: { ok: false, error: "not found" } };
  if (!adminOk && (!client || rec.clientId !== client.clientId)) {
    return { code: 403, obj: { ok: false, error: "not your request" } };
  }
  var text = String(body.text || "").trim();
  if (!text) return { code: 400, obj: { ok: false, error: "empty message" } };
  rec.meta = rec.meta || { activity: [] };
  var thread = (rec.meta.thread || []).slice();
  thread.push({ at: now_(), from: adminOk ? "team" : "client", text: text });
  rec.meta.thread = thread;
  var merged = mergePatch_(rec, {}, now_());
  writeRow_(SHEET_REQUESTS, rec.__row, merged);
  return { code: 200, obj: { ok: true, request: stripRowMeta_(merged) } };
}

function handleSubmitRequest_(body, client) {
  var adminOk = !!(body.admin && safeEquals_(body.admin, getAdminToken_()));
  var input = {};
  var k;
  for (k in (body.request || {})) { if (body.request.hasOwnProperty(k)) input[k] = body.request[k]; }
  // Tenant FORCED from the auth'd client token; a body clientId is honored only for
  // admin. Stops one client's token from planting a request into another tenant.
  input.clientId = adminOk ? ((body.request && body.request.clientId) || (client && client.clientId)) : (client && client.clientId);
  var v = validateRequestInput_(input);
  if (!v.ok) return { code: 400, obj: { ok: false, errors: v.errors } };
  var id = genId_("req");
  var rec = {
    id: id,
    clientId: v.value.clientId,
    type: v.value.type,
    title: v.value.title,
    description: v.value.description,
    attachments: v.value.attachments,
    eventId: v.value.eventId,
    stage: "submitted",
    comment: "",
    scheduledFor: "",
    draft: null,
    changeNote: "",
    createdAt: now_(),
    updatedAt: now_(),
    meta: { activity: [{ at: now_(), kind: "created", text: "submitted via portal" }] }
  };
  appendRow_(SHEET_REQUESTS, rec);
  return { code: 200, obj: { ok: true, id: id } };
}

function handleAddEvent_(body, client) {
  var adminOk = !!(body.admin && safeEquals_(body.admin, getAdminToken_()));
  var input = {};
  var k;
  for (k in (body.event || {})) { if (body.event.hasOwnProperty(k)) input[k] = body.event[k]; }
  input.clientId = adminOk ? ((body.event && body.event.clientId) || (client && client.clientId)) : (client && client.clientId);
  var v = validateEventInput_(input);
  if (!v.ok) return { code: 400, obj: { ok: false, errors: v.errors } };
  var eventId = genId_("evt");
  var rec = {
    eventId: eventId,
    clientId: v.value.clientId,
    title: v.value.title,
    date: v.value.date,
    time: v.value.time,
    description: v.value.description,
    promoted: false,
    requestId: "",
    createdAt: now_(),
    updatedAt: now_()
  };
  appendRow_(SHEET_EVENTS, rec);
  return { code: 200, obj: { ok: true, eventId: eventId } };
}

function handleUploadAttachment_(body) {
  var file = body.file || {};
  // Reject oversized uploads up front (base64 length ~10M chars ≈ 7MB binary) so a big
  // photo can't blow the payload ceiling or hold the write lock; the portal also
  // compresses before upload.
  if (String(file.dataBase64 || "").length > 10000000) {
    return { code: 413, obj: { ok: false, error: "file too large (max ~7MB) — try a smaller photo" } };
  }
  var safe = String(file.name || "file").replace(/[^a-zA-Z0-9._-]/g, "_");
  var fname = genId_("att") + "-" + safe;
  var mime = file.mime || "";
  var bytes = Utilities.base64Decode(String(file.dataBase64 || ""));
  var blob = Utilities.newBlob(bytes, mime || "application/octet-stream", fname);
  var folder = getUploadFolder_();
  var driveFile = folder.createFile(blob);
  // Anyone-with-link can view (so the portal/desk can preview the attachment).
  try {
    driveFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (shareErr) {
    // Some domains restrict link-sharing; URL still returned, owner-visible.
  }
  return {
    code: 200,
    obj: { ok: true, url: driveFile.getUrl(), name: file.name || safe, mime: mime }
  };
}

function handleUpdateRequest_(body) {
  var requests = readAll_(SHEET_REQUESTS);
  var rec = null;
  for (var i = 0; i < requests.length; i++) {
    if (requests[i].id === body.id) { rec = requests[i]; break; }
  }
  if (!rec) return { code: 404, obj: { ok: false, error: "not found" } };

  // Re-read the freshest copy for the merge (rec already is freshest under lock).
  var cur = rec;
  var patch = {};
  var k;
  for (k in (body.patch || {})) { if (body.patch.hasOwnProperty(k)) patch[k] = body.patch[k]; }

  if (patch.action) {
    var nxt;
    try {
      nxt = nextStage_(cur.stage, patch.action);
    } catch (transErr) {
      return { code: 409, obj: { ok: false, error: transErr.message } };
    }
    patch.stage = nxt;
    var act = patch.action;
    delete patch.action;
    cur.meta = cur.meta || { activity: [] };
    var activity = (cur.meta.activity || []).slice();
    activity.push({ at: now_(), kind: act, text: (patch._note != null ? patch._note : act) });
    cur.meta.activity = activity;
    // A successful draft clears the orphan-recovery retry counter (mirrors worker/jobs.mjs)
    // so a long-lived request that re-drafts later isn't pre-charged toward the cap.
    if (act === "ready") {
      var run = cur.meta.run || {};
      run.requeues = 0;
      run.error = "";
      cur.meta.run = run;
    }
  }
  delete patch._note;

  var merged = mergePatch_(cur, patch, now_());
  writeRow_(SHEET_REQUESTS, cur.__row, merged);
  return { code: 200, obj: { ok: true, request: stripRowMeta_(merged) } };
}

function handlePromoteEvent_(body) {
  var events = readAll_(SHEET_EVENTS);
  var ev = null;
  for (var i = 0; i < events.length; i++) {
    if (events[i].eventId === body.eventId) { ev = events[i]; break; }
  }
  if (!ev) return { code: 404, obj: { ok: false, error: "event not found" } };

  var id = genId_("req");
  var rec = {
    id: id,
    clientId: ev.clientId,
    type: "event-promo",
    title: "Promote: " + ev.title,
    description: (ev.title + " on " + ev.date + ". " + (ev.description || "")).trim(),
    attachments: [],
    eventId: ev.eventId,
    stage: "submitted",
    comment: "",
    scheduledFor: "",
    draft: null,
    changeNote: "",
    createdAt: now_(),
    updatedAt: now_(),
    meta: { activity: [{ at: now_(), kind: "created", text: "promoted from event" }] }
  };
  appendRow_(SHEET_REQUESTS, rec);

  ev.promoted = true;
  ev.requestId = id;
  ev.updatedAt = now_();
  writeRow_(SHEET_EVENTS, ev.__row, ev);

  return { code: 200, obj: { ok: true, requestId: id } };
}

function handleUpsertClient_(body) {
  var cl = body.client || {};
  if (!cl.clientId) return { code: 400, obj: { ok: false, error: "clientId required" } };

  var clients = readAll_(SHEET_CLIENTS);
  var existing = null;
  for (var i = 0; i < clients.length; i++) {
    if (clients[i].clientId === cl.clientId) { existing = clients[i]; break; }
  }

  // base: existing row, or a fresh shell with a new token + createdAt.
  var base = existing
    ? existing
    : { token: genToken_(24), createdAt: now_() };

  // merged = { defaults, ...base, ...cl, updatedAt }  — order matches the mock.
  var merged = {
    active: true, pin: "", brandSlug: "", postizChannels: [], siteFolder: ""
  };
  var k;
  for (k in base) { if (base.hasOwnProperty(k) && k !== "__row") merged[k] = base[k]; }
  for (k in cl) { if (cl.hasOwnProperty(k)) merged[k] = cl[k]; }
  merged.updatedAt = now_();

  // Guarantee every column is present so the row writes cleanly.
  if (merged.createdAt === undefined) merged.createdAt = now_();
  if (merged.name === undefined) merged.name = "";
  if (merged.siteFolder === undefined) merged.siteFolder = "";

  if (existing) {
    writeRow_(SHEET_CLIENTS, existing.__row, merged);
  } else {
    appendRow_(SHEET_CLIENTS, merged);
  }
  return { code: 200, obj: { ok: true, clientId: merged.clientId, token: merged.token } };
}

/* ============================ setup / seeding / menu ============================ */

function setup() {
  // 1. Ensure the three tabs + headers exist.
  getOrCreateSheet_(SHEET_CLIENTS, COLS_CLIENTS);
  getOrCreateSheet_(SHEET_REQUESTS, COLS_REQUESTS);
  getOrCreateSheet_(SHEET_EVENTS, COLS_EVENTS);

  // 2. Generate an admin token if not already set.
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty(PROP_ADMIN_TOKEN);
  if (!token) {
    token = genToken_(24);
    props.setProperty(PROP_ADMIN_TOKEN, token);
  }

  // 3. Ensure the upload folder exists.
  var folder = getUploadFolder_();

  Logger.log("Client Hub setup complete.");
  Logger.log("ADMIN_TOKEN: " + token);
  Logger.log("UPLOAD_FOLDER_ID: " + folder.getId() + "  (\"" + UPLOAD_FOLDER_NAME + "\")");
  return { ok: true, adminToken: token, uploadFolderId: folder.getId() };
}

function seedPilotClients() {
  setup(); // make sure tabs + token + folder exist first (idempotent)

  var seeds = [
    { clientId: "the-o", name: "The O", brandSlug: "the-o" },
    { clientId: "eats-on-601", name: "Eats on 601", brandSlug: "eats-on-601" }
  ];

  var clients = readAll_(SHEET_CLIENTS);
  for (var s = 0; s < seeds.length; s++) {
    var seed = seeds[s];
    var existing = null;
    for (var i = 0; i < clients.length; i++) {
      if (clients[i].clientId === seed.clientId) { existing = clients[i]; break; }
    }
    var base = existing ? existing : { token: genToken_(24), createdAt: now_() };
    var merged = {
      active: true, pin: "", brandSlug: "", postizChannels: [], siteFolder: ""
    };
    var k;
    for (k in base) { if (base.hasOwnProperty(k) && k !== "__row") merged[k] = base[k]; }
    merged.clientId = seed.clientId;
    merged.name = seed.name;
    merged.brandSlug = seed.brandSlug;
    // Fresh token each seed run (per spec) only when creating; keep existing token on re-seed.
    if (!existing) merged.token = genToken_(24);
    merged.active = true;
    merged.updatedAt = now_();
    if (merged.createdAt === undefined) merged.createdAt = now_();
    if (merged.siteFolder === undefined) merged.siteFolder = "";

    if (existing) writeRow_(SHEET_CLIENTS, existing.__row, merged);
    else appendRow_(SHEET_CLIENTS, merged);
  }

  var ui = safeUi_();
  if (ui) {
    ui.alert(
      "Pilot clients ready",
      "the-o and eats-on-601 are seeded and active.\n\n" +
      "Their portal link tokens are in the Clients tab (token column). " +
      "Build each portal URL as  ?c=<token>  (admin desk uses ?admin=<ADMIN_TOKEN>).",
      ui.ButtonSet.OK
    );
  }
  return { ok: true };
}

function onOpen() {
  var ui = safeUi_();
  if (!ui) return;
  ui.createMenu("Client Hub")
    .addItem("Show admin token", "showAdminToken_")
    .addItem("Run setup", "setup")
    .addItem("Seed pilot clients", "seedPilotClients")
    .addToUi();
}

function showAdminToken_() {
  var ui = safeUi_();
  var token = getAdminToken_();
  if (!token) {
    if (ui) ui.alert("No admin token yet", "Run \"Run setup\" first to generate one.", ui.ButtonSet.OK);
    return;
  }
  if (ui) ui.alert("Client Hub admin token", token, ui.ButtonSet.OK);
}

// SpreadsheetApp.getUi() throws when not in a UI context (e.g. web-app run);
// guard so headless calls (doGet/doPost, triggers) never break.
function safeUi_() {
  try {
    return SpreadsheetApp.getUi();
  } catch (e) {
    return null;
  }
}
