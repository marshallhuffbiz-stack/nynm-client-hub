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
  submit: (request) => http("POST", "", { c: clientToken, action: "submitRequest", request }),
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

// Turn a File object into the {name,mime,dataBase64} the upload action expects.
export function fileToPayload(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const b64 = String(reader.result).split(",")[1] || "";
      resolve({ name: file.name, mime: file.type || "application/octet-stream", dataBase64: b64 });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
