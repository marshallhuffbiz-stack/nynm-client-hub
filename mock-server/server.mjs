import http from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createStore } from "./store.mjs";
import { genId, genToken } from "../core/ids.mjs";
import {
  validateRequestInput,
  validateEventInput,
  validateVendorInput,
  validateBookingInput,
  validatePin,
  publicClient,
  nextStage,
  mergePatch,
  planRequeue,
} from "../core/model.mjs";

const now = () => new Date().toISOString();

// "19:30" -> "7:30 PM" (promo descriptions read like copy, not timestamps).
function fmt12(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ""));
  if (!m) return "";
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h >= 12 ? "PM" : "AM"}`;
}

// Server-side deep-merge for request `meta` (mirrors apps-script/Code.gs mergeMeta_).
// A writeback that patches meta must MERGE, not clobber: workers send meta computed
// from a fetch minutes old, and a wholesale overlay silently dropped thread messages,
// the activity entry the server just appended, notified flags, and idempotency keys.
// Rules: thread/activity arrays union-append (dedupe identical entries, sort by `at`);
// nested plain objects (e.g. run) shallow-merge with patch winning per key;
// scalars overwrite.
function mergeMeta(cur = {}, patch = {}) {
  const out = { ...cur };
  for (const [k, v] of Object.entries(patch)) {
    const curV = out[k];
    if ((k === "thread" || k === "activity") && Array.isArray(v) && Array.isArray(curV)) {
      const seen = new Set(curV.map((e) => JSON.stringify(e)));
      out[k] = curV
        .concat(v.filter((e) => !seen.has(JSON.stringify(e))))
        .sort((a, b) => String((a && a.at) || "").localeCompare(String((b && b.at) || "")));
    } else if (
      v && typeof v === "object" && !Array.isArray(v) &&
      curV && typeof curV === "object" && !Array.isArray(curV)
    ) {
      out[k] = { ...curV, ...v };
    } else {
      out[k] = v;
    }
  }
  return out;
}

function send(res, code, obj) {
  res.writeHead(code, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(s || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

// createApp returns an http.Server (not yet listening) so tests can pick a port.
export function createApp({ storePath, uploadsDir }) {
  const store = createStore(storePath);
  uploadsDir = uploadsDir || join(storePath, "..", "uploads");

  return http.createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") return send(res, 204, {});
      const url = new URL(req.url, "http://localhost");
      const publicBase = `http://${req.headers.host || "127.0.0.1:8787"}`;

      // Serve uploaded attachment files (the mock's stand-in for Drive).
      if (req.method === "GET" && url.pathname.startsWith("/uploads/")) {
        const f = join(uploadsDir, url.pathname.replace("/uploads/", ""));
        if (existsSync(f)) {
          const data = await readFile(f);
          res.writeHead(200, { "access-control-allow-origin": "*" });
          return res.end(data);
        }
        return send(res, 404, { ok: false, error: "not found" });
      }

      if (req.method === "GET") {
        const data = await store.read();
        const admin = url.searchParams.get("admin");
        const c = url.searchParams.get("client") || url.searchParams.get("c");
        if (admin != null) {
          if (admin !== data.settings?.adminToken) return send(res, 403, { ok: false, error: "bad admin token" });
          return send(res, 200, {
            ok: true,
            clients: data.clients,
            requests: data.requests,
            events: data.events,
            vendors: data.vendors || [],
            bookings: data.bookings || [],
          });
        }
        if (c != null) {
          const client = data.clients.find((x) => x.token === c && x.active !== false);
          if (!client) return send(res, 403, { ok: false, error: "bad client link" });
          if (!validatePin(client, url.searchParams.get("pin")))
            return send(res, 401, { ok: false, error: "pin required", needPin: true });
          return send(res, 200, {
            ok: true,
            client: publicClient(client),
            requests: data.requests.filter((r) => r.clientId === client.clientId),
            events: data.events.filter((e) => e.clientId === client.clientId),
            vendors: (data.vendors || []).filter((v) => v.clientId === client.clientId && v.active !== false),
            bookings: (data.bookings || []).filter((b) => b.clientId === client.clientId && b.status !== "cancelled"),
          });
        }
        return send(res, 400, { ok: false, error: "missing token" });
      }

      if (req.method === "POST") {
        const body = await readBody(req);
        const action = body.action;
        const data0 = await store.read();
        const adminOk = body.admin && body.admin === data0.settings?.adminToken;
        const client = body.c ? data0.clients.find((x) => x.token === body.c) : null;

        if (["updateRequest", "promoteEvent", "upsertClient", "deleteRequest"].includes(action) && !adminOk)
          return send(res, 403, { ok: false, error: "admin required" });
        if (["submitRequest", "addEvent", "uploadAttachment", "postMessage", "upsertVendor", "addBookings", "updateBooking", "deleteBooking"].includes(action) && !client && !adminOk)
          return send(res, 403, { ok: false, error: "client link required" });

        const result = await store.tx(async (data) => {
          // Old stores predate the food-truck feature; keep the arrays present.
          if (!Array.isArray(data.vendors)) data.vendors = [];
          if (!Array.isArray(data.bookings)) data.bookings = [];
          // Tenant is FORCED from the auth'd client token for tenant-scoped writes;
          // a body clientId is honored only for admin (mirrors submitRequest/addEvent).
          const ftClientId = adminOk ? (body.clientId || client?.clientId) : client?.clientId;
          switch (action) {
            case "submitRequest": {
              // Tenant is FORCED from the authenticated client token; a body clientId is
              // honored only for admin. Stops a client with one token from planting a
              // request into another client's tenant (cross-tenant write spoof).
              const forcedClientId = adminOk ? (body.request?.clientId || client?.clientId) : client?.clientId;
              // Idempotency: a flaky-network retry carrying the same clientRequestId must
              // not create a duplicate row — return the original.
              if (body.clientRequestId) {
                const dup = data.requests.find((r) => r.meta && r.meta.clientRequestId === body.clientRequestId);
                if (dup) return { code: 200, obj: { ok: true, id: dup.id, deduped: true } };
              }
              const v = validateRequestInput({ ...body.request, clientId: forcedClientId });
              if (!v.ok) return { code: 400, obj: { ok: false, errors: v.errors } };
              const id = genId("req");
              data.requests.push({
                id,
                ...v.value,
                stage: "submitted",
                comment: "",
                scheduledFor: "",
                draft: null,
                changeNote: "",
                createdAt: now(),
                updatedAt: now(),
                meta: { clientRequestId: body.clientRequestId || "", activity: [{ at: now(), kind: "created", text: "submitted via portal" }] },
              });
              return { code: 200, obj: { ok: true, id } };
            }
            case "addEvent": {
              const forcedEventClientId = adminOk ? (body.event?.clientId || client?.clientId) : client?.clientId;
              const v = validateEventInput({ ...body.event, clientId: forcedEventClientId });
              if (!v.ok) return { code: 400, obj: { ok: false, errors: v.errors } };
              const eventId = genId("evt");
              data.events.push({ eventId, ...v.value, promoted: false, requestId: "", createdAt: now(), updatedAt: now() });
              return { code: 200, obj: { ok: true, eventId } };
            }
            case "uploadAttachment": {
              const file = body.file || {};
              // Reject oversized uploads up front (base64 length ~10M chars ≈ 7MB binary).
              // Big phone photos otherwise inflate ~33% and can blow the backend payload
              // ceiling / hold the write lock; the portal compresses before upload too.
              if (String(file.dataBase64 || "").length > 10_000_000)
                return { code: 413, obj: { ok: false, error: "file too large (max ~7MB) — try a smaller photo" } };
              const safe = String(file.name || "file").replace(/[^a-zA-Z0-9._-]/g, "_");
              const fname = `${genId("att")}-${safe}`;
              await mkdir(uploadsDir, { recursive: true });
              await writeFile(join(uploadsDir, fname), Buffer.from(String(file.dataBase64 || ""), "base64"));
              return { code: 200, obj: { ok: true, url: `${publicBase}/uploads/${fname}`, name: file.name || safe, mime: file.mime || "" } };
            }
            case "updateRequest": {
              const idx = data.requests.findIndex((r) => r.id === body.id);
              if (idx < 0) return { code: 404, obj: { ok: false, error: "not found" } };
              const cur = data.requests[idx];
              const patch = { ...(body.patch || {}) };
              // [V9] Identity fields are IMMUTABLE through patches. mergePatch is a
              // blind overlay, so a stray patch carrying id/clientId/createdAt (e.g. a
              // caller echoing a whole fetched row back as the patch, or a blank
              // clientId) used to re-key or de-tenant the row — and the client GET
              // filters on clientId, so the request silently vanished from its
              // client's portal. Mirrors handleUpdateRequest_ in apps-script/Code.gs.
              delete patch.id;
              delete patch.clientId;
              delete patch.createdAt;
              if (patch.action) {
                if (patch.action === "requeue") {
                  // First-class retry: only errored or stuck-shipping rows may requeue.
                  // planRequeue decides the safe target — a publish-phase failure with
                  // an approved draft goes back to "approved" KEEPING the draft (no
                  // re-drafting run burned); anything else re-queues for a fresh draft.
                  if (cur.stage !== "error" && cur.stage !== "shipping")
                    return { code: 409, obj: { ok: false, error: `illegal transition: ${cur.stage} --requeue-->` } };
                  const plan = planRequeue(cur);
                  patch.stage = plan.stage;
                  if (Object.prototype.hasOwnProperty.call(plan, "draft")) patch.draft = plan.draft;
                } else {
                  try {
                    patch.stage = nextStage(cur.stage, patch.action);
                  } catch (e) {
                    return { code: 409, obj: { ok: false, error: e.message } };
                  }
                }
                const act = patch.action;
                delete patch.action;
                cur.meta = cur.meta || { activity: [] };
                cur.meta.activity = (cur.meta.activity || []).concat([{ at: now(), kind: act, text: patch._note || act }]);
                // A successful draft clears the orphan-recovery retry counter, so a
                // long-lived request that re-drafts later starts fresh instead of being
                // pre-charged toward the give-up cap.
                if (act === "ready") cur.meta.run = { ...(cur.meta.run || {}), requeues: 0, error: "" };
                // A requeue clears the stale error so the Desk stops showing it.
                if (act === "requeue") cur.meta.run = { ...(cur.meta.run || {}), error: "" };
              }
              delete patch._note;
              // Deep-merge (never clobber) any meta carried by the patch — preserves
              // thread/activity/notified/clientRequestId written since the caller's fetch.
              if (patch.meta && typeof patch.meta === "object" && !Array.isArray(patch.meta))
                patch.meta = mergeMeta(cur.meta || {}, patch.meta);
              data.requests[idx] = mergePatch(cur, patch, now());
              return { code: 200, obj: { ok: true, request: data.requests[idx] } };
            }
            case "deleteRequest": {
              const idx = data.requests.findIndex((r) => r.id === body.id);
              if (idx < 0) return { code: 404, obj: { ok: false, error: "not found" } };
              const [removed] = data.requests.splice(idx, 1);
              return { code: 200, obj: { ok: true, id: removed.id, deleted: true } };
            }
            case "postMessage": {
              const idx = data.requests.findIndex((r) => r.id === body.id);
              if (idx < 0) return { code: 404, obj: { ok: false, error: "not found" } };
              const cur = data.requests[idx];
              // a client may only post to its own request; admin may post to any
              if (!adminOk && (!client || cur.clientId !== client.clientId))
                return { code: 403, obj: { ok: false, error: "not your request" } };
              const text = String(body.text || "").trim();
              if (!text) return { code: 400, obj: { ok: false, error: "empty message" } };
              cur.meta = cur.meta || { activity: [] };
              cur.meta.thread = (cur.meta.thread || []).concat([{ at: now(), from: adminOk ? "team" : "client", text }]);
              data.requests[idx] = mergePatch(cur, {}, now());
              return { code: 200, obj: { ok: true, request: data.requests[idx] } };
            }
            case "promoteEvent": {
              const ev = data.events.find((e) => e.eventId === body.eventId);
              if (!ev) return { code: 404, obj: { ok: false, error: "event not found" } };
              // Carry the start/end times the client entered into the promo brief —
              // the whole point of collecting them is a post that says "7–10 PM".
              let when = "";
              if (ev.time && ev.endTime) when = `, ${fmt12(ev.time)}–${fmt12(ev.endTime)}`;
              else if (ev.time) when = `, starting ${fmt12(ev.time)}`;
              else if (ev.endTime) when = `, until ${fmt12(ev.endTime)}`;
              const id = genId("req");
              data.requests.push({
                id,
                clientId: ev.clientId,
                type: "event-promo",
                title: `Promote: ${ev.title}`,
                description: `${ev.title} on ${ev.date}${when}. ${ev.description || ""}`.trim(),
                attachments: [],
                eventId: ev.eventId,
                stage: "submitted",
                comment: "",
                scheduledFor: "",
                draft: null,
                changeNote: "",
                createdAt: now(),
                updatedAt: now(),
                meta: { activity: [{ at: now(), kind: "created", text: "promoted from event" }] },
              });
              ev.promoted = true;
              ev.requestId = id;
              ev.updatedAt = now();
              return { code: 200, obj: { ok: true, requestId: id } };
            }
            case "upsertVendor": {
              const v = validateVendorInput({ ...body.vendor, clientId: ftClientId });
              if (!v.ok) return { code: 400, obj: { ok: false, errors: v.errors } };
              const i = data.vendors.findIndex((x) => x.id === v.value.id && x.clientId === v.value.clientId);
              if (i >= 0) {
                const prevName = data.vendors[i].name;
                data.vendors[i] = { ...data.vendors[i], ...v.value, updatedAt: now() };
                // Rename: rewrite the denormalized vendorName snapshot on this vendor's
                // bookings so lists show the corrected name (mirrors handleUpsertVendor_).
                if (prevName !== v.value.name) {
                  for (const b of data.bookings) {
                    if (b.vendorId === v.value.id && b.clientId === v.value.clientId && b.vendorName !== v.value.name) {
                      b.vendorName = v.value.name;
                      b.updatedAt = now();
                    }
                  }
                }
              } else {
                data.vendors.push({ ...v.value, createdAt: now(), updatedAt: now() });
              }
              return { code: 200, obj: { ok: true, vendorId: v.value.id } };
            }
            case "addBookings": {
              const list = Array.isArray(body.bookings) ? body.bookings : [];
              // Only this client's active vendors may be booked (validateBookingInput
              // resolves + snapshots the vendor name from here).
              const scopedVendors = data.vendors.filter((x) => x.clientId === ftClientId);
              const seriesId = String(body.seriesId || "").trim();
              const validated = [];
              for (const b of list) {
                const vb = validateBookingInput({ ...b, clientId: ftClientId }, scopedVendors);
                if (!vb.ok) return { code: 400, obj: { ok: false, errors: vb.errors } };
                validated.push(vb.value);
              }
              // Atomic: nothing inserted unless every booking validated.
              const ids = [];
              for (const value of validated) {
                const id = genId("bkg");
                ids.push(id);
                data.bookings.push({
                  id,
                  ...value,
                  seriesId,
                  status: "scheduled",
                  createdAt: now(),
                  updatedAt: now(),
                });
              }
              return { code: 200, obj: { ok: true, ids } };
            }
            case "updateBooking": {
              const idx = data.bookings.findIndex((b) => b.id === body.id && (adminOk || b.clientId === ftClientId));
              if (idx < 0) return { code: 404, obj: { ok: false, error: "not found" } };
              const cur = data.bookings[idx];
              const patch = { ...(body.patch || {}) };
              // Identity fields are immutable through a patch (only time/note/status).
              delete patch.id;
              delete patch.clientId;
              delete patch.vendorId;
              delete patch.vendorName;
              delete patch.createdAt;
              delete patch.seriesId;
              data.bookings[idx] = mergePatch(cur, patch, now());
              return { code: 200, obj: { ok: true, booking: data.bookings[idx] } };
            }
            case "deleteBooking": {
              const seriesId = String(body.seriesId || "").trim();
              if (seriesId) {
                const before = data.bookings.length;
                data.bookings = data.bookings.filter(
                  (b) => !(b.seriesId === seriesId && (adminOk || b.clientId === ftClientId))
                );
                const deleted = before - data.bookings.length;
                if (deleted === 0) return { code: 404, obj: { ok: false, error: "not found" } };
                return { code: 200, obj: { ok: true, deleted } };
              }
              const idx = data.bookings.findIndex((b) => b.id === body.id && (adminOk || b.clientId === ftClientId));
              if (idx < 0) return { code: 404, obj: { ok: false, error: "not found" } };
              const [removed] = data.bookings.splice(idx, 1);
              return { code: 200, obj: { ok: true, id: removed.id, deleted: 1 } };
            }
            case "upsertClient": {
              const cl = body.client || {};
              if (!cl.clientId) return { code: 400, obj: { ok: false, error: "clientId required" } };
              const i = data.clients.findIndex((x) => x.clientId === cl.clientId);
              const base = i >= 0 ? data.clients[i] : { token: genToken(24), createdAt: now() };
              const merged = { active: true, pin: "", brandSlug: "", postizChannels: [], siteFolder: "", ...base, ...cl, updatedAt: now() };
              if (i >= 0) data.clients[i] = merged;
              else data.clients.push(merged);
              return { code: 200, obj: { ok: true, clientId: merged.clientId, token: merged.token } };
            }
            default:
              return { code: 400, obj: { ok: false, error: "unknown action" } };
          }
        });
        return send(res, result.code, result.obj);
      }

      return send(res, 405, { ok: false, error: "method not allowed" });
    } catch (e) {
      return send(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const storePath = process.env.STORE || join(process.cwd(), "data", "store.json");
  const port = Number(process.env.PORT || 8787);
  createApp({ storePath }).listen(port, "127.0.0.1", () =>
    console.log(`Client Hub mock backend on http://127.0.0.1:${port}  (store: ${storePath})`)
  );
}
