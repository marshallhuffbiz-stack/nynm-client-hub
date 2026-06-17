// Browser API client. Talks to API_BASE (mock locally, Apps Script in prod).
import { API_BASE } from "./config.js";

async function http(method, query, body) {
  const res = await fetch(API_BASE + (query || ""), {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
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
    http("GET", `?c=${encodeURIComponent(clientToken)}${pin ? `&pin=${encodeURIComponent(pin)}` : ""}`),
  submit: (request) => http("POST", "", { c: clientToken, action: "submitRequest", request }),
  addEvent: (event) => http("POST", "", { c: clientToken, action: "addEvent", event }),
  upload: (file) => http("POST", "", { c: clientToken, action: "uploadAttachment", file }),
});

// Request Desk — admin token in the URL (?k=…).
export const deskApi = (adminToken) => ({
  load: () => http("GET", `?admin=${encodeURIComponent(adminToken)}`),
  update: (id, patch) => http("POST", "", { admin: adminToken, action: "updateRequest", id, patch }),
  promote: (eventId) => http("POST", "", { admin: adminToken, action: "promoteEvent", eventId }),
  upsertClient: (client) => http("POST", "", { admin: adminToken, action: "upsertClient", client }),
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
