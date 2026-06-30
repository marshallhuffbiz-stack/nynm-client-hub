// Browser API client. Talks to API_BASE (mock locally, Apps Script in prod).
import { API_BASE } from "./config.js";

async function http(method, query, body) {
  const res = await fetch(API_BASE + (query || ""), {
    method,
    // text/plain keeps POSTs as "simple" CORS requests (no preflight), which is
    // required for the live Apps Script backend. The server parses the JSON body
    // regardless of content-type, so this works for both mock and live.
    headers: body ? { "content-type": "text/plain;charset=utf-8" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try {
    data = await res.json();
  } catch {
    data = { ok: false, error: "bad json from server" };
  }
  // Mock returns real HTTP statuses; live Apps Script always returns 200 and
  // carries the intended status in the body. Prefer the body status when present
  // so the UIs behave identically in both modes.
  const status = typeof data.status === "number" ? data.status : res.status;
  return { ...data, status };
}

// Client Portal — secret token in the URL (?c=…), optional PIN.
export const portalApi = (clientToken, pin = "") => ({
  load: () =>
    http("GET", `?client=${encodeURIComponent(clientToken)}${pin ? `&pin=${encodeURIComponent(pin)}` : ""}`),
  submit: (request, clientRequestId) => http("POST", "", { c: clientToken, action: "submitRequest", request, clientRequestId }),
  addEvent: (event) => http("POST", "", { c: clientToken, action: "addEvent", event }),
  upload: (file) => http("POST", "", { c: clientToken, action: "uploadAttachment", file }),
  message: (id, text) => http("POST", "", { c: clientToken, action: "postMessage", id, text }),
});

// Request Desk — admin token in the URL (?k=…).
export const deskApi = (adminToken) => ({
  load: () => http("GET", `?admin=${encodeURIComponent(adminToken)}`),
  update: (id, patch) => http("POST", "", { admin: adminToken, action: "updateRequest", id, patch }),
  promote: (eventId) => http("POST", "", { admin: adminToken, action: "promoteEvent", eventId }),
  upsertClient: (client) => http("POST", "", { admin: adminToken, action: "upsertClient", client }),
  remove: (id) => http("POST", "", { admin: adminToken, action: "deleteRequest", id }),
  message: (id, text) => http("POST", "", { admin: adminToken, action: "postMessage", id, text }),
});

// Downscale + re-encode large images IN THE BROWSER before upload. Phone photos run
// 3–12MB; sent raw as base64 (+33%) they're slow on mobile data and can blow the
// backend payload ceiling. Cap the longest edge and re-encode JPEG. Non-images,
// GIFs, and already-small images pass through untouched. Best-effort: ANY failure
// (or no size win) falls back to the original file, so this can never make an upload
// worse — at worst it's a no-op.
export async function compressImage(file, { maxEdge = 2000, quality = 0.82, skipUnder = 600 * 1024 } = {}) {
  try {
    if (!file || !/^image\//.test(file.type) || file.type === "image/gif") return file;
    if (file.size <= skipUnder) return file;
    if (typeof createImageBitmap !== "function" || typeof document === "undefined") return file;
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
    if (bitmap.close) bitmap.close();
    const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", quality));
    if (!blob || blob.size >= file.size) return file; // no win -> keep the original
    const name = String(file.name || "photo").replace(/\.(heic|heif|png|webp|jpe?g)$/i, "") + ".jpg";
    return new File([blob], name, { type: "image/jpeg" });
  } catch {
    return file;
  }
}

// Turn a File object into the {name,mime,dataBase64} the upload action expects,
// compressing large images first.
export async function fileToPayload(file) {
  const f = await compressImage(file);
  const b64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(f);
  });
  return { name: f.name, mime: f.type || "application/octet-stream", dataBase64: b64 };
}
