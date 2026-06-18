// Thin API client for the worker (Node side). Talks to the same token-gated
// endpoint as the browser, with the admin token.
export async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
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

// Upload a file (base64) and get back a hosted URL (Drive in prod). Used by the
// drain to turn a locally-rendered draft image into something the Desk can show.
export function apiUpload(apiBase, adminToken, file) {
  return fetchJson(apiBase, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ admin: adminToken, action: "uploadAttachment", file }),
  });
}
