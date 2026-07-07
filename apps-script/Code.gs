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
var SHEET_VENDORS = "Vendors";
var SHEET_BOOKINGS = "Bookings";

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
  "promoted", "requestId", "createdAt", "updatedAt", "time", "endTime"
];
var COLS_VENDORS = [
  "id", "clientId", "name", "category", "price",
  "tagline", "active", "createdAt", "updatedAt"
];
var COLS_BOOKINGS = [
  "id", "clientId", "vendorId", "vendorName", "date",
  "startTime", "endTime", "note", "seriesId", "status", "createdAt", "updatedAt"
];

// Per-tab: which columns are JSON-encoded in the cell, and which are booleans.
var JSON_FIELDS = {
  Clients: ["postizChannels"],
  Requests: ["attachments", "draft", "meta"],
  Events: [],
  Vendors: [],
  Bookings: []
};
var BOOL_FIELDS = {
  Clients: ["active"],
  Requests: [],
  Events: ["promoted"],
  Vendors: ["active"],
  Bookings: []
};

// [V9] Per-tab: columns that MUST stay plain text in the cell. Google Sheets
// auto-coerces "16:00" into a time cell (read back as a Date on the Sheets epoch,
// 1899-12-30) and "2026-07-04" into a date cell — the portal's formatter expects
// "HH:MM"/"YYYY-MM-DD" strings and silently showed nothing. These columns are
// written apostrophe-prefixed (forces text) and normalized back to strings on read.
var TEXT_FIELDS = {
  Clients: [],
  Requests: [],
  Events: ["date", "time", "endTime"],
  Vendors: [],
  Bookings: ["date", "startTime", "endTime"]
};

// Mirror of core/model.mjs REQUEST_TYPES.
var REQUEST_TYPES = ["post", "website", "design", "event-promo"];

// Mirror of core/model.mjs STAGES (documentation / reference).
var STAGES = [
  "submitted", "queued", "drafting", "ready", "changes",
  "approved", "shipping", "done", "error"
];

// Mirror of core/model.mjs TRANSITIONS  (stage:action -> next stage).
// [V7] The "requeue" action is handled OUTSIDE this table (handleUpdateRequest_):
// allowed only from error/shipping, target decided by planRequeue_().
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
  if (sheetName === SHEET_VENDORS) return COLS_VENDORS;
  if (sheetName === SHEET_BOOKINGS) return COLS_BOOKINGS;
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
    // [V9] While self-migrating headers, pin the time/date columns to plain-text
    // format so Sheets never coerces "16:00" / "2026-07-04" into time/date cells.
    var textCols = TEXT_FIELDS[name] || [];
    for (var t = 0; t < textCols.length; t++) {
      var ci = cols.indexOf(textCols[t]);
      if (ci >= 0) s.getRange(1, ci + 1, s.getMaxRows(), 1).setNumberFormat("@");
    }
  }
  return s;
}

// [V9] Spreadsheet timezone (cached) — time/date cells read back as Date objects
// carry wall-clock meaning in the SPREADSHEET's timezone, not the script's.
var SHEET_TZ_CACHE_ = null;
function sheetTz_() {
  if (!SHEET_TZ_CACHE_) {
    SHEET_TZ_CACHE_ = ss_().getSpreadsheetTimeZone() || Session.getScriptTimeZone() || "Etc/UTC";
  }
  return SHEET_TZ_CACHE_;
}

// [V9] Normalize a time-ish cell back to "HH:MM" (24h, zero-padded).
// Sheets coerces a "16:00" string into a time cell; GAS reads it back as a Date
// on the Sheets epoch (1899-12-30) — the portal's formatter expects "HH:MM" and
// silently showed nothing. Mirrored by a pure-JS copy in test/contract.test.mjs.
function normalizeTimeCell_(raw) {
  if (raw === null || raw === undefined || raw === "") return "";
  if (Object.prototype.toString.call(raw) === "[object Date]") {
    return Utilities.formatDate(raw, sheetTz_(), "HH:mm");
  }
  var s = String(raw).trim();
  // Real Sheets never returns the text-forcing apostrophe, but defensively strip
  // one (harnesses / CSV round-trips can surface it as a literal).
  if (s.charAt(0) === "'") s = s.slice(1);
  // "16:00:00" -> "16:00"; "9:30" -> "09:30"; already-good "HH:MM" passes through.
  var m = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(s);
  if (m) return ("0" + m[1]).slice(-2) + ":" + m[2];
  return s;
}

// [V9] Normalize a date-ish cell back to "YYYY-MM-DD" (Sheets coerces the string
// to a date cell; GAS reads a Date back). Mirrored in test/contract.test.mjs.
function normalizeDateCell_(raw) {
  if (raw === null || raw === undefined || raw === "") return "";
  if (Object.prototype.toString.call(raw) === "[object Date]") {
    return Utilities.formatDate(raw, sheetTz_(), "yyyy-MM-dd");
  }
  var s = String(raw).trim();
  if (s.charAt(0) === "'") s = s.slice(1);
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
  // [V9] Time/date columns: undo Sheets' cell coercion so the API always serves
  // "HH:MM" / "YYYY-MM-DD" strings (legacy rows written before the text-format
  // guard still hold real Date cells).
  if (TEXT_FIELDS[sheetName].indexOf(field) >= 0) {
    return (field === "date") ? normalizeDateCell_(raw) : normalizeTimeCell_(raw);
  }
  // [V9] Belt-and-braces: any OTHER scalar column Sheets coerced into a datetime
  // (e.g. an ISO createdAt/updatedAt) goes back over the wire as an ISO string,
  // never a serialized Date.
  if (Object.prototype.toString.call(raw) === "[object Date]") {
    return raw.toISOString();
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
  // [V9] Belt-and-braces on WRITE: force time/date columns in as text. A leading
  // apostrophe is Sheets' text-forcing prefix (honored by setValues/appendRow just
  // like UI typing; it is NOT part of the stored value), so "16:00" stays the
  // string "16:00" instead of becoming a time cell. Rewrites of legacy rows
  // self-heal them to text.
  if (TEXT_FIELDS[sheetName].indexOf(field) >= 0) {
    var sv = String(val === null || val === undefined ? "" : val).trim();
    return sv === "" ? "" : "'" + sv;
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
  var endTime = String(input.endTime || "").trim(); // optional end time, "HH:MM" 24-hour
  if (endTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime)) errors.push("endTime must be HH:MM (24-hour)");
  if (errors.length) return { ok: false, errors: errors };
  return {
    ok: true,
    errors: [],
    value: { clientId: clientId, title: title, date: date, time: time, endTime: endTime, description: String(input.description || "").trim() }
  };
}

var VENDOR_PRICES = ["$", "$$", "$$$"];

// Stable url-safe slug from a display name — mirrors slugId() in core/model.mjs.
function slugId_(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

// mirror validateVendorInput() in core/model.mjs.
function validateVendorInput_(input) {
  var errors = [];
  if (!input || typeof input !== "object") return { ok: false, errors: ["missing input"] };
  var clientId = String(input.clientId || "").trim();
  if (!clientId) errors.push("clientId required");
  var name = String(input.name || "").trim();
  if (!name) errors.push("name required");
  var category = String(input.category || "").trim();
  if (!category) errors.push("category required");
  var price = String(input.price || "").trim();
  if (VENDOR_PRICES.indexOf(price) < 0) errors.push("price must be one of " + VENDOR_PRICES.join(", "));
  if (errors.length) return { ok: false, errors: errors };
  var id = String(input.id || "").trim() || slugId_(name);
  var active = (input.active == null) ? true : !!input.active;
  return {
    ok: true,
    errors: [],
    value: { id: id, clientId: clientId, name: name, category: category, price: price, tagline: String(input.tagline || "").trim(), active: active }
  };
}

// mirror validateBookingInput() in core/model.mjs. `vendors` is the client's scoped
// registry; vendorId must resolve to an ACTIVE vendor, whose name is snapshotted.
function validateBookingInput_(input, vendors) {
  vendors = vendors || [];
  var errors = [];
  if (!input || typeof input !== "object") return { ok: false, errors: ["missing input"] };
  var clientId = String(input.clientId || "").trim();
  if (!clientId) errors.push("clientId required");
  var vendorId = String(input.vendorId || "").trim();
  var vendor = null;
  for (var i = 0; i < vendors.length; i++) {
    if (vendors[i].id === vendorId && vendors[i].clientId === clientId && vendors[i].active !== false) { vendor = vendors[i]; break; }
  }
  if (!vendorId) errors.push("vendorId required");
  else if (!vendor) errors.push("vendorId must resolve to an active vendor");
  var date = String(input.date || "").trim();
  if (!isIsoDate_(date)) errors.push("date must be YYYY-MM-DD");
  var startTime = String(input.startTime || "").trim() || "09:00";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)) errors.push("startTime must be HH:MM (24-hour)");
  var endTime = String(input.endTime || "").trim() || "17:00";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime)) errors.push("endTime must be HH:MM (24-hour)");
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime) && /^([01]\d|2[0-3]):[0-5]\d$/.test(endTime) && endTime < startTime) {
    errors.push("endTime must be >= startTime");
  }
  if (errors.length) return { ok: false, errors: errors };
  return {
    ok: true,
    errors: [],
    value: {
      clientId: clientId,
      vendorId: vendorId,
      vendorName: vendor ? vendor.name : "",
      date: date,
      startTime: startTime,
      endTime: endTime,
      note: String(input.note || "").trim()
    }
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

// [V7] "19:30" -> "7:30 PM" (promo descriptions read like copy, not timestamps).
// Mirrors fmt12() in mock-server/server.mjs.
function fmt12_(hhmm) {
  var m = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ""));
  if (!m) return "";
  var h = Number(m[1]);
  return (h % 12 || 12) + ":" + m[2] + " " + (h >= 12 ? "PM" : "AM");
}

// [V7] Server-side deep-merge for request `meta` — mirrors mergeMeta() in
// mock-server/server.mjs. A writeback that patches meta must MERGE, not clobber:
// workers send meta computed from a fetch minutes old, and a wholesale overlay
// silently dropped thread messages, the activity entry the server just appended,
// notified flags, and idempotency keys. Rules: thread/activity arrays union-append
// (dedupe identical entries, sort by `at`); nested plain objects (e.g. run)
// shallow-merge with patch winning per key; scalars overwrite.
function mergeMeta_(cur, patch) {
  cur = cur || {};
  patch = patch || {};
  var out = {};
  var k;
  for (k in cur) { if (cur.hasOwnProperty(k)) out[k] = cur[k]; }
  for (k in patch) {
    if (!patch.hasOwnProperty(k)) continue;
    var v = patch[k];
    var curV = out[k];
    if ((k === "thread" || k === "activity") && isArray_(v) && isArray_(curV)) {
      var seen = {};
      var merged = curV.slice();
      var i;
      for (i = 0; i < curV.length; i++) seen[JSON.stringify(curV[i])] = true;
      for (i = 0; i < v.length; i++) {
        if (!seen[JSON.stringify(v[i])]) merged.push(v[i]);
      }
      merged.sort(function (a, b) {
        var aAt = String((a && a.at) || "");
        var bAt = String((b && b.at) || "");
        return aAt < bAt ? -1 : aAt > bAt ? 1 : 0;
      });
      out[k] = merged;
    } else if (v && typeof v === "object" && !isArray_(v) && curV && typeof curV === "object" && !isArray_(curV)) {
      var m = {};
      var mk;
      for (mk in curV) { if (curV.hasOwnProperty(mk)) m[mk] = curV[mk]; }
      for (mk in v) { if (v.hasOwnProperty(mk)) m[mk] = v[mk]; }
      out[k] = m;
    } else {
      out[k] = v;
    }
  }
  return out;
}

// [V7] mirror planRequeue() in core/model.mjs: what a "Retry / requeue" of a failed
// request should do. A failure AFTER approval (run.phase === "publish": Postiz blip,
// shipper crash, interrupted publish) still has a reviewed, approved draft — requeue
// it to the SHIP lane (stage "approved", draft KEPT) instead of wiping the creative
// and burning another drafting run. Anything else conservatively re-queues for a
// fresh draft.
function planRequeue_(request) {
  var run = (request && request.meta && request.meta.run) || {};
  if (run.phase === "publish" && request.draft) return { stage: "approved" };
  return { stage: "queued", draft: null };
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
        events: readAll_(SHEET_EVENTS).map(stripRowMeta_),
        vendors: readAll_(SHEET_VENDORS).map(stripRowMeta_),
        bookings: readAll_(SHEET_BOOKINGS).map(stripRowMeta_)
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
      var vens = readAll_(SHEET_VENDORS).filter(function (v) { return v.clientId === client.clientId && v.active !== false; });
      var bks = readAll_(SHEET_BOOKINGS).filter(function (b) { return b.clientId === client.clientId && b.status !== "cancelled"; });
      return json_(200, {
        ok: true,
        client: publicClient_(client),
        requests: reqs.map(stripRowMeta_),
        events: evs.map(stripRowMeta_),
        vendors: vens.map(stripRowMeta_),
        bookings: bks.map(stripRowMeta_)
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
    if (["submitRequest", "addEvent", "uploadAttachment", "postMessage", "upsertVendor", "addBookings", "updateBooking", "deleteBooking"].indexOf(action) >= 0 && !clientForAuth && !adminOk) {
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
        case "upsertVendor":
          result = handleUpsertVendor_(body, clientForAuth);
          break;
        case "addBookings":
          result = handleAddBookings_(body, clientForAuth);
          break;
        case "updateBooking":
          result = handleUpdateBooking_(body, clientForAuth);
          break;
        case "deleteBooking":
          result = handleDeleteBooking_(body, clientForAuth);
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
  // Idempotency: a flaky-network retry carrying the same clientRequestId must not
  // create a duplicate row — return the original id.
  if (body.clientRequestId) {
    var existingReqs = readAll_(SHEET_REQUESTS);
    for (var di = 0; di < existingReqs.length; di++) {
      if (existingReqs[di].meta && existingReqs[di].meta.clientRequestId === body.clientRequestId) {
        return { code: 200, obj: { ok: true, id: existingReqs[di].id, deduped: true } };
      }
    }
  }
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
    meta: { clientRequestId: body.clientRequestId || "", activity: [{ at: now_(), kind: "created", text: "submitted via portal" }] }
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
    endTime: v.value.endTime,
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

  // [V9] Identity fields are IMMUTABLE through patches. mergePatch_ is a blind
  // overlay, so a stray patch carrying id/clientId/createdAt (e.g. a caller echoing
  // a whole fetched row back as the patch, or a blank clientId) used to re-key or
  // de-tenant the row — and doGet filters requests by clientId, so the request
  // silently vanished from its client's portal. __row is internal bookkeeping and
  // must never come from the wire either. Mirrors mock-server/server.mjs.
  delete patch.id;
  delete patch.clientId;
  delete patch.createdAt;
  delete patch.__row;

  if (patch.action) {
    var nxt;
    if (patch.action === "requeue") {
      // [V7] First-class retry: only errored or stuck-shipping rows may requeue.
      // planRequeue_ decides the safe target — a publish-phase failure with an
      // approved draft goes back to "approved" KEEPING the draft (no re-drafting
      // run burned); anything else re-queues for a fresh draft.
      if (cur.stage !== "error" && cur.stage !== "shipping") {
        return { code: 409, obj: { ok: false, error: "illegal transition: " + cur.stage + " --requeue-->" } };
      }
      var plan = planRequeue_(cur);
      nxt = plan.stage;
      if (plan.hasOwnProperty("draft")) patch.draft = plan.draft;
    } else {
      try {
        nxt = nextStage_(cur.stage, patch.action);
      } catch (transErr) {
        return { code: 409, obj: { ok: false, error: transErr.message } };
      }
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
    // [V7] A requeue clears the stale error so the Desk stops showing it.
    if (act === "requeue") {
      var rerun = cur.meta.run || {};
      rerun.error = "";
      cur.meta.run = rerun;
    }
  }
  delete patch._note;

  // [V7] Deep-merge (never clobber) any meta carried by the patch — preserves
  // thread/activity/notified/clientRequestId written since the caller's fetch.
  if (patch.meta && typeof patch.meta === "object" && !isArray_(patch.meta)) {
    patch.meta = mergeMeta_(cur.meta || {}, patch.meta);
  }

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

  // [V7] Carry the start/end times the client entered into the promo brief —
  // the whole point of collecting them is a post that says "7–10 PM".
  var when = "";
  if (ev.time && ev.endTime) when = ", " + fmt12_(ev.time) + "–" + fmt12_(ev.endTime);
  else if (ev.time) when = ", starting " + fmt12_(ev.time);
  else if (ev.endTime) when = ", until " + fmt12_(ev.endTime);

  var id = genId_("req");
  var rec = {
    id: id,
    clientId: ev.clientId,
    type: "event-promo",
    title: "Promote: " + ev.title,
    description: (ev.title + " on " + ev.date + when + ". " + (ev.description || "")).trim(),
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

/* ============================ Food-truck action handlers ============================ */

// Tenant FORCED from the auth'd client token; a body clientId is honored only for
// admin (mirrors handleSubmitRequest_ / handleAddEvent_).
function forcedClientId_(body, client) {
  var adminOk = !!(body.admin && safeEquals_(body.admin, getAdminToken_()));
  return adminOk ? (body.clientId || (client && client.clientId)) : (client && client.clientId);
}

// upsertVendor: add or update a registry row. Id omitted -> slug from name. Returns vendorId.
function handleUpsertVendor_(body, client) {
  var input = {};
  var k;
  for (k in (body.vendor || {})) { if (body.vendor.hasOwnProperty(k)) input[k] = body.vendor[k]; }
  input.clientId = forcedClientId_(body, client);
  var v = validateVendorInput_(input);
  if (!v.ok) return { code: 400, obj: { ok: false, errors: v.errors } };

  var vendors = readAll_(SHEET_VENDORS);
  var existing = null;
  for (var i = 0; i < vendors.length; i++) {
    if (vendors[i].id === v.value.id && vendors[i].clientId === v.value.clientId) { existing = vendors[i]; break; }
  }
  if (existing) {
    var merged = {};
    for (k in existing) { if (existing.hasOwnProperty(k) && k !== "__row") merged[k] = existing[k]; }
    for (k in v.value) { if (v.value.hasOwnProperty(k)) merged[k] = v.value[k]; }
    merged.updatedAt = now_();
    writeRow_(SHEET_VENDORS, existing.__row, merged);
  } else {
    var rec = {
      id: v.value.id, clientId: v.value.clientId, name: v.value.name, category: v.value.category,
      price: v.value.price, tagline: v.value.tagline, active: v.value.active,
      createdAt: now_(), updatedAt: now_()
    };
    appendRow_(SHEET_VENDORS, rec);
  }
  return { code: 200, obj: { ok: true, vendorId: v.value.id } };
}

// addBookings: batch insert (one round-trip for repeat-weekly). Validates EACH against
// the client's active registry; nothing is inserted unless every booking validates.
function handleAddBookings_(body, client) {
  var clientId = forcedClientId_(body, client);
  var list = isArray_(body.bookings) ? body.bookings : [];
  var scopedVendors = readAll_(SHEET_VENDORS).filter(function (x) { return x.clientId === clientId; });
  var seriesId = String(body.seriesId || "").trim();

  var validated = [];
  for (var i = 0; i < list.length; i++) {
    var input = {};
    var k;
    for (k in list[i]) { if (list[i].hasOwnProperty(k)) input[k] = list[i][k]; }
    input.clientId = clientId;
    var vb = validateBookingInput_(input, scopedVendors);
    if (!vb.ok) return { code: 400, obj: { ok: false, errors: vb.errors } };
    validated.push(vb.value);
  }

  var ids = [];
  for (var j = 0; j < validated.length; j++) {
    var value = validated[j];
    var id = genId_("bkg");
    ids.push(id);
    appendRow_(SHEET_BOOKINGS, {
      id: id, clientId: value.clientId, vendorId: value.vendorId, vendorName: value.vendorName,
      date: value.date, startTime: value.startTime, endTime: value.endTime, note: value.note,
      seriesId: seriesId, status: "scheduled", createdAt: now_(), updatedAt: now_()
    });
  }
  return { code: 200, obj: { ok: true, ids: ids } };
}

// updateBooking: merge a time/note/status patch (identity fields immutable), stamp updatedAt.
function handleUpdateBooking_(body, client) {
  var adminOk = !!(body.admin && safeEquals_(body.admin, getAdminToken_()));
  var clientId = forcedClientId_(body, client);
  var bookings = readAll_(SHEET_BOOKINGS);
  var rec = null;
  for (var i = 0; i < bookings.length; i++) {
    if (bookings[i].id === body.id && (adminOk || bookings[i].clientId === clientId)) { rec = bookings[i]; break; }
  }
  if (!rec) return { code: 404, obj: { ok: false, error: "not found" } };

  var patch = {};
  var k;
  for (k in (body.patch || {})) { if (body.patch.hasOwnProperty(k)) patch[k] = body.patch[k]; }
  // Identity fields are immutable through a patch (only time/note/status).
  delete patch.id;
  delete patch.clientId;
  delete patch.vendorId;
  delete patch.vendorName;
  delete patch.createdAt;
  delete patch.seriesId;
  delete patch.__row;

  var merged = mergePatch_(rec, patch, now_());
  writeRow_(SHEET_BOOKINGS, rec.__row, merged);
  return { code: 200, obj: { ok: true, booking: stripRowMeta_(merged) } };
}

// deleteBooking: remove one booking by id, OR the whole series by seriesId.
function handleDeleteBooking_(body, client) {
  var adminOk = !!(body.admin && safeEquals_(body.admin, getAdminToken_()));
  var clientId = forcedClientId_(body, client);
  var sheet = getOrCreateSheet_(SHEET_BOOKINGS, colsFor_(SHEET_BOOKINGS));
  var bookings = readAll_(SHEET_BOOKINGS);
  var seriesId = String(body.seriesId || "").trim();

  if (seriesId) {
    // Collect matching rows, then delete bottom-up so row indices stay valid.
    var rows = [];
    for (var i = 0; i < bookings.length; i++) {
      if (bookings[i].seriesId === seriesId && (adminOk || bookings[i].clientId === clientId)) rows.push(bookings[i].__row);
    }
    if (rows.length === 0) return { code: 404, obj: { ok: false, error: "not found" } };
    rows.sort(function (a, b) { return b - a; });
    for (var r = 0; r < rows.length; r++) sheet.deleteRow(rows[r]);
    return { code: 200, obj: { ok: true, deleted: rows.length } };
  }

  var rec = null;
  for (var j = 0; j < bookings.length; j++) {
    if (bookings[j].id === body.id && (adminOk || bookings[j].clientId === clientId)) { rec = bookings[j]; break; }
  }
  if (!rec) return { code: 404, obj: { ok: false, error: "not found" } };
  sheet.deleteRow(rec.__row);
  return { code: 200, obj: { ok: true, id: body.id, deleted: 1 } };
}

/* ============================ setup / seeding / menu ============================ */

function setup() {
  // 1. Ensure the tabs + headers exist.
  getOrCreateSheet_(SHEET_CLIENTS, COLS_CLIENTS);
  getOrCreateSheet_(SHEET_REQUESTS, COLS_REQUESTS);
  getOrCreateSheet_(SHEET_EVENTS, COLS_EVENTS);
  getOrCreateSheet_(SHEET_VENDORS, COLS_VENDORS);
  getOrCreateSheet_(SHEET_BOOKINGS, COLS_BOOKINGS);

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
