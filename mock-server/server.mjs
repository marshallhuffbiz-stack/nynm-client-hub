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
  validatePin,
  publicClient,
  nextStage,
  mergePatch,
} from "../core/model.mjs";

const now = () => new Date().toISOString();

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
          return send(res, 200, { ok: true, clients: data.clients, requests: data.requests, events: data.events });
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
        if (["submitRequest", "addEvent", "uploadAttachment", "postMessage"].includes(action) && !client && !adminOk)
          return send(res, 403, { ok: false, error: "client link required" });

        const result = await store.tx(async (data) => {
          switch (action) {
            case "submitRequest": {
              // Tenant is FORCED from the authenticated client token; a body clientId is
              // honored only for admin. Stops a client with one token from planting a
              // request into another client's tenant (cross-tenant write spoof).
              const forcedClientId = adminOk ? (body.request?.clientId || client?.clientId) : client?.clientId;
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
                meta: { activity: [{ at: now(), kind: "created", text: "submitted via portal" }] },
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
              if (patch.action) {
                try {
                  patch.stage = nextStage(cur.stage, patch.action);
                } catch (e) {
                  return { code: 409, obj: { ok: false, error: e.message } };
                }
                const act = patch.action;
                delete patch.action;
                cur.meta = cur.meta || { activity: [] };
                cur.meta.activity = (cur.meta.activity || []).concat([{ at: now(), kind: act, text: patch._note || act }]);
                // A successful draft clears the orphan-recovery retry counter, so a
                // long-lived request that re-drafts later starts fresh instead of being
                // pre-charged toward the give-up cap.
                if (act === "ready") cur.meta.run = { ...(cur.meta.run || {}), requeues: 0, error: "" };
              }
              delete patch._note;
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
              const id = genId("req");
              data.requests.push({
                id,
                clientId: ev.clientId,
                type: "event-promo",
                title: `Promote: ${ev.title}`,
                description: `${ev.title} on ${ev.date}. ${ev.description || ""}`.trim(),
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
