// Thin API client for the worker (Node side). Talks to the same token-gated
// endpoint as the browser, with the admin token.
export async function fetchJson(url, opts) {
  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    // Network failure (DNS, offline, reset). Fail soft so a single bad call
    // can't throw out of a ship/draft batch and abort the rest of the tick.
    return { ok: false, status: 0, error: "network error: " + (e && e.message ? e.message : String(e)) };
  }
  let data;
  try {
    data = await res.json();
  } catch {
    data = { ok: false, error: "bad json" };
  }
  return { status: res.status, ...data };
}

export function apiFetchAll(apiBase, adminToken) {
  return fetchJson(`${apiBase}?admin=${encodeURIComponent(adminToken)}`);
}

export function apiUpdate(apiBase, adminToken, id, patch) {
  return fetchJson(apiBase, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ admin: adminToken, action: "updateRequest", id, patch }),
  });
}

// Post a message into a request's client↔team thread as admin (the backend's
// postMessage action). Used by the shipper to tell the client their post is live.
export function apiMessage(apiBase, adminToken, id, text) {
  return fetchJson(apiBase, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ admin: adminToken, action: "postMessage", id, text }),
  });
}

// Upload a file (base64) and get back a hosted URL (Drive in prod). Used by the
// drain to turn a locally-rendered draft image into something the Desk can show.
export function apiUpload(apiBase, adminToken, file) {
  return fetchJson(apiBase, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ admin: adminToken, action: "uploadAttachment", file }),
  });
}
