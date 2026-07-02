/**
 * gas-harness.mjs — run the REAL Apps Script backend (apps-script/Code.gs) under Node.
 *
 * Loads Code.gs from disk AT RUNTIME (so it always tests the current file) and
 * evaluates it inside a `node:vm` context whose globals are faithful in-memory
 * stubs of every Google Apps Script API the file uses:
 *
 *   SpreadsheetApp  — openById/getActiveSpreadsheet -> one in-memory spreadsheet
 *                     with named sheets (Clients/Requests/Events), header row +
 *                     data rows as 2D arrays; getRange/getValues/setValues/
 *                     appendRow/deleteRow/getLastRow/setFrozenRows/insertSheet.
 *                     getUi() throws (mirrors headless web-app execution).
 *   LockService     — no-op script lock.
 *   ContentService  — createTextOutput captures the JSON text (read it back via
 *                     .getContent()).
 *   PropertiesService — in-memory script properties, pre-seeded with ADMIN_TOKEN.
 *   DriveApp        — in-memory folders/files; createFile records the blob so
 *                     tests can assert on the decoded bytes.
 *   Utilities       — getUuid (crypto), base64Decode (Buffer), newBlob.
 *   Logger          — no-op.
 *
 * STRICTNESS: every stub object is wrapped in a Proxy that THROWS on any
 * property Code.gs touches that we did not implement. Because doGet/doPost wrap
 * handlers in try/catch, such a throw surfaces as a { status: 500, error:
 * "GAS stub ... not implemented ..." } response — the contract assertion then
 * fails loudly with the exact missing API in the message. Nothing passes
 * silently.
 *
 * Usage:
 *   const h = createHarness();                    // seeds the default fixture
 *   const res = h.get({ client: "tok-o" });       // doGet -> parsed JSON body
 *   const res = h.post({ c: "tok-o", action: "submitRequest", request: {...} });
 *   res.status carries the intended HTTP code (GAS always replies HTTP 200).
 */

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CODE_GS_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "apps-script", "Code.gs");

/* ---------------- strict stub wrapper: unknown API access fails loudly ---------------- */

// Properties that runtimes/JSON probe on any object; let them pass through.
const PASSTHROUGH = new Set(["then", "toJSON", "valueOf", "toString", "constructor", "inspect"]);

function strict(name, target) {
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === "symbol") return Reflect.get(t, prop, receiver);
      if (prop in t) return Reflect.get(t, prop, receiver);
      if (PASSTHROUGH.has(prop)) return Reflect.get(t, prop, receiver);
      throw new Error(
        `GAS stub ${name}.${String(prop)} not implemented — Code.gs called an API the harness does not stub; add it to test/gas-harness.mjs`
      );
    },
  });
}

/* ---------------- in-memory Sheet / Range ---------------- */

// Sheets write semantics: a leading apostrophe is the text-forcing prefix — it is
// consumed on write (setValues/appendRow behave like UI typing) and is NOT part of
// the stored value. Code.gs [V9] leans on this to keep "16:00" a string.
function sheetsWriteCoerce(v) {
  if (typeof v === "string" && v.startsWith("'")) return v.slice(1);
  return v;
}

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    this.sheet = sheet;
    this.row = row;
    this.col = col;
    this.numRows = numRows;
    this.numCols = numCols;
  }
  // Real Sheets returns "" for empty cells (never undefined).
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const rowArr = this.sheet.rows[this.row - 1 + r] || [];
      const line = [];
      for (let c = 0; c < this.numCols; c++) {
        const v = rowArr[this.col - 1 + c];
        line.push(v === undefined || v === null ? "" : v);
      }
      out.push(line);
    }
    return out;
  }
  setValues(vals) {
    if (!Array.isArray(vals) || vals.length !== this.numRows) {
      throw new Error(`setValues: expected ${this.numRows} rows, got ${vals && vals.length}`);
    }
    for (let r = 0; r < this.numRows; r++) {
      if (vals[r].length !== this.numCols) {
        throw new Error(`setValues: row ${r} expected ${this.numCols} cols, got ${vals[r].length}`);
      }
      const idx = this.row - 1 + r;
      while (this.sheet.rows.length <= idx) this.sheet.rows.push([]);
      const rowArr = this.sheet.rows[idx];
      for (let c = 0; c < this.numCols; c++) {
        rowArr[this.col - 1 + c] = sheetsWriteCoerce(vals[r][c]);
      }
    }
    return this;
  }
  setNumberFormat(fmt) {
    this._numberFormat = fmt; // plain-text pinning ("@") — recorded, no coercion in the fake
    return this;
  }
}

class FakeSheet {
  constructor(name) {
    this.name = name;
    this.rows = []; // rows[0] = header row; 1-based sheet row N = rows[N-1]
    this.frozenRows = 0;
  }
  getName() {
    return this.name;
  }
  getLastRow() {
    return this.rows.length;
  }
  getLastColumn() {
    return this.rows.reduce((m, r) => Math.max(m, r.length), 0);
  }
  // Real Sheets pre-allocates a 1000-row grid on a fresh sheet.
  getMaxRows() {
    return Math.max(this.rows.length, 1000);
  }
  getRange(row, col, numRows = 1, numCols = 1) {
    return strict(`Range(${this.name})`, new FakeRange(this, row, col, numRows, numCols));
  }
  appendRow(vals) {
    this.rows.push(vals.map(sheetsWriteCoerce));
    return this;
  }
  deleteRow(rowIndex) {
    if (rowIndex < 1 || rowIndex > this.rows.length) throw new Error(`deleteRow: no row ${rowIndex}`);
    this.rows.splice(rowIndex - 1, 1);
    return this;
  }
  setFrozenRows(n) {
    this.frozenRows = n;
    return this;
  }
}

/* ---------------- default fixture ---------------- */

export const FIXTURE = {
  ADMIN: "testadmin",
  TOK_O: "tok-o", // the-o, no pin
  TOK_E: "tok-e", // eats-on-601, pin-protected
  PIN_E: "4321",
};

const T0 = "2026-07-01T12:00:00.000Z";

function defaultSeed() {
  return {
    clients: [
      {
        clientId: "the-o", name: "The O", token: FIXTURE.TOK_O, pin: "", brandSlug: "the-o",
        postizChannels: [], siteFolder: "", active: true, createdAt: T0, updatedAt: T0,
      },
      {
        clientId: "eats-on-601", name: "Eats on 601", token: FIXTURE.TOK_E, pin: FIXTURE.PIN_E, brandSlug: "eats-on-601",
        postizChannels: [], siteFolder: "", active: true, createdAt: T0, updatedAt: T0,
      },
    ],
    requests: [
      {
        id: "req_theo_1", clientId: "the-o", type: "post", title: "Friday special",
        description: "Promote the Friday special", stage: "submitted",
        meta: { activity: [{ at: T0, kind: "created", text: "seed" }] },
      },
      {
        id: "req_eats_1", clientId: "eats-on-601", type: "design", title: "New menu",
        description: "New menu one-pager", stage: "queued",
        meta: { activity: [{ at: T0, kind: "created", text: "seed" }] },
      },
    ],
    events: [
      {
        eventId: "evt_theo_1", clientId: "the-o", title: "Wine tasting", date: "2026-07-18",
        time: "19:00", endTime: "22:00", description: "five pours", promoted: false, requestId: "",
      },
    ],
  };
}

const REQUEST_DEFAULTS = {
  attachments: [], eventId: "", comment: "", scheduledFor: "", draft: null,
  changeNote: "", createdAt: T0, updatedAt: T0, meta: { activity: [] },
};
const EVENT_DEFAULTS = { description: "", promoted: false, requestId: "", time: "", endTime: "", createdAt: T0, updatedAt: T0 };

/* ---------------- harness factory ---------------- */

// Timezone the fake spreadsheet reports (mirrors a US-East production sheet).
export const SHEET_TZ = "America/New_York";

// Faithful Utilities.formatDate for the tokens Code.gs uses (HH:mm, yyyy-MM-dd).
function formatDate(date, tz, format) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return String(format)
    .replace(/yyyy/g, p.year)
    .replace(/MM/g, p.month)
    .replace(/dd/g, p.day)
    .replace(/HH/g, p.hour === "24" ? "00" : p.hour)
    .replace(/mm/g, p.minute)
    .replace(/ss/g, p.second);
}

export function createHarness(opts = {}) {
  const adminToken = opts.adminToken ?? FIXTURE.ADMIN;
  const seed = opts.seed === undefined ? defaultSeed() : opts.seed;

  /* --- stores --- */
  const sheets = new Map(); // name -> FakeSheet
  const props = new Map([["ADMIN_TOKEN", adminToken]]);
  const drive = { folders: new Map(), files: [] };

  /* --- stubs --- */
  const spreadsheet = strict("Spreadsheet", {
    getSpreadsheetTimeZone: () => SHEET_TZ,
    getSheetByName: (name) => sheets.get(name) || null,
    insertSheet: (name) => {
      if (sheets.has(name)) throw new Error(`insertSheet: sheet "${name}" already exists`);
      const s = strict(`Sheet(${name})`, new FakeSheet(name));
      sheets.set(name, s);
      return s;
    },
  });

  const SpreadsheetApp = strict("SpreadsheetApp", {
    openById: () => spreadsheet,
    getActiveSpreadsheet: () => spreadsheet,
    getUi: () => {
      // Real GAS throws outside a UI context (web-app runs); safeUi_ relies on it.
      throw new Error("Cannot call SpreadsheetApp.getUi() from this context.");
    },
  });

  const LockService = strict("LockService", {
    getScriptLock: () =>
      strict("Lock", {
        waitLock: () => {},
        tryLock: () => true,
        releaseLock: () => {},
        hasLock: () => true,
      }),
  });

  const ContentService = strict("ContentService", {
    MimeType: strict("ContentService.MimeType", { JSON: "application/json" }),
    createTextOutput: (text) =>
      strict("TextOutput", {
        _text: String(text),
        _mime: null,
        setMimeType(m) {
          this._mime = m;
          return this;
        },
        getContent() {
          return this._text;
        },
      }),
  });

  const PropertiesService = strict("PropertiesService", {
    getScriptProperties: () =>
      strict("ScriptProperties", {
        getProperty: (k) => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => {
          props.set(k, String(v));
        },
        deleteProperty: (k) => {
          props.delete(k);
        },
      }),
  });

  function makeFolder() {
    const id = "fold_" + randomUUID().replace(/-/g, "").slice(0, 12);
    const folder = strict("Folder", {
      getId: () => id,
      createFile: (blob) => {
        const fid = "file_" + randomUUID().replace(/-/g, "").slice(0, 12);
        drive.files.push({ id: fid, folderId: id, blob });
        return strict("File", {
          getId: () => fid,
          getUrl: () => `https://drive.google.com/file/d/${fid}/view`,
          setSharing: () => {},
        });
      },
    });
    drive.folders.set(id, folder);
    return folder;
  }

  const DriveApp = strict("DriveApp", {
    Access: strict("DriveApp.Access", { ANYONE_WITH_LINK: "ANYONE_WITH_LINK" }),
    Permission: strict("DriveApp.Permission", { VIEW: "VIEW" }),
    createFolder: () => makeFolder(),
    getFolderById: (id) => {
      const f = drive.folders.get(id);
      if (!f) throw new Error(`DriveApp.getFolderById: no folder ${id}`);
      return f;
    },
  });

  const Session = strict("Session", {
    getScriptTimeZone: () => SHEET_TZ,
  });

  const Utilities = strict("Utilities", {
    getUuid: () => randomUUID(),
    formatDate: (date, tz, format) => formatDate(date, tz, format),
    base64Decode: (s) => Array.from(Buffer.from(String(s), "base64")),
    newBlob: (bytes, mime, name) =>
      strict("Blob", { _bytes: bytes, _mime: mime, _name: name, getName: () => name, getBytes: () => bytes }),
  });

  const Logger = strict("Logger", { log: () => {} });

  /* --- evaluate the REAL Code.gs from disk --- */
  const src = readFileSync(CODE_GS_PATH, "utf8");
  const sandbox = { SpreadsheetApp, LockService, ContentService, PropertiesService, DriveApp, Utilities, Logger, Session };
  const context = vm.createContext(sandbox);
  new vm.Script(src, { filename: "apps-script/Code.gs" }).runInContext(context);

  if (typeof context.doGet !== "function" || typeof context.doPost !== "function") {
    throw new Error("Code.gs did not define doGet/doPost — harness cannot run the contract");
  }

  /* --- seed fixture through Code.gs's own encoder (appendRow_) --- */
  if (seed) {
    for (const c of seed.clients || []) context.appendRow_("Clients", { ...c });
    for (const r of seed.requests || []) context.appendRow_("Requests", { ...REQUEST_DEFAULTS, ...r });
    for (const ev of seed.events || []) context.appendRow_("Events", { ...EVENT_DEFAULTS, ...ev });
  }

  /* --- invocation helpers: parse the captured JSON reply --- */
  function get(parameter = {}) {
    const out = context.doGet({ parameter });
    return JSON.parse(out.getContent());
  }
  function post(body = {}) {
    const out = context.doPost({ postData: { contents: JSON.stringify(body), type: "text/plain" } });
    return JSON.parse(out.getContent());
  }

  return { get, post, context, sheets, drive, props, adminToken, stubs: sandbox };
}
