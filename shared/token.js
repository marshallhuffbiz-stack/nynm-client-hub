// Durable access-token handling for Relay's token-gated PWAs (portal + desk).
//
// Why this exists: a client's identity lives in the URL (?c=… / ?k=…). When the
// page is added to the home screen, the OS relaunches the manifest's start_url —
// which drops the query string — so the installed app would open with no token
// and dead-end on "This link isn't valid." These helpers (1) recover the token
// from durable storage when the URL has none, and (2) build a launch URL that
// carries the token so "Add to Home Screen" captures the right link.

// localStorage keys (namespaced so portal and desk never collide).
export const PORTAL_TOKEN_KEY = "relay.portal.token";
export const PORTAL_PIN_KEY = "relay.portal.pin";
export const DESK_TOKEN_KEY = "relay.desk.token";

// Resolve the access token: URL query first (the canonical link the contact
// sends), then durable storage (so an installed app that launched without the
// query string still recovers the token it saw on first open).
export function resolveAccess({
  search = "",
  storage = null,
  param = "c",
  pinParam = "pin",
  tokenKey,
  pinKey,
} = {}) {
  const params = new URLSearchParams(search || "");
  let token = (params.get(param) || "").trim();
  let pin = (params.get(pinParam) || "").trim();
  let source = token ? "url" : "none";

  if (!token && storage && tokenKey) {
    try {
      const stored = (storage.getItem(tokenKey) || "").trim();
      if (stored) {
        token = stored;
        source = "storage";
        if (!pin && pinKey) pin = (storage.getItem(pinKey) || "").trim();
      }
    } catch {
      /* storage blocked (private mode); fall through to none */
    }
  }

  return { token, pin, source };
}

// Persist a *verified* token (and optional PIN) so future launches survive a
// dropped query string. No-ops on an empty token or blocked storage — never
// clobbers a good stored token with a blank.
export function persistAccess(storage, { token, pin, tokenKey, pinKey } = {}) {
  if (!storage || !token || !tokenKey) return;
  try {
    storage.setItem(tokenKey, token);
    if (pinKey && pin) storage.setItem(pinKey, pin);
  } catch {
    /* quota / private mode — best effort only */
  }
}

// Build an absolute launch URL that carries the token in `param`, overriding any
// stale value and stripping the fragment. Used as the dynamic manifest start_url
// so "Add to Home Screen" records a link that reopens the correct portal.
export function tokenStartUrl(href, param, token) {
  const u = new URL(href);
  u.searchParams.set(param, token);
  u.hash = "";
  return u.href;
}

// The directory URL of the current document — the manifest scope. start_url must
// live within scope, so we point scope at the portal/desk directory itself.
export function scopeFromHref(href) {
  const u = new URL(href);
  u.search = "";
  u.hash = "";
  u.pathname = u.pathname.replace(/[^/]*$/, "");
  return u.href;
}
