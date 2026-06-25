// Dynamic launch manifest — the half of the home-screen fix that lives in the DOM.
//
// The static manifest.webmanifest ships start_url "./", which the OS relaunches
// with no query string, dropping the client's token. Here we replace the manifest
// at runtime with one whose start_url carries the token, so "Add to Home Screen"
// records a launch link that reopens the correct portal. Pure URL math lives in
// token.js; this module is the thin glue (and is `doc`-injectable for tests).

import { tokenStartUrl, scopeFromHref } from "./token.js";

// Build a manifest object whose start_url carries the token. Icon srcs are
// resolved to absolute against the original manifest URL, because a data: URL
// manifest has no base for relative paths to resolve against.
export function buildLaunchManifest(base, { href, manifestHref, param, token }) {
  const out = { ...base };
  out.start_url = tokenStartUrl(href, param, token);
  out.scope = scopeFromHref(href);
  if (Array.isArray(base.icons) && manifestHref) {
    out.icons = base.icons.map((icon) => ({
      ...icon,
      src: icon && icon.src ? new URL(icon.src, manifestHref).href : icon && icon.src,
    }));
  }
  return out;
}

// Inject (or replace) <link rel="manifest"> with a data: manifest carrying the
// token. Returns the data URL, or null when there's no token / no document.
export function installLaunchManifest({ doc, base, href, manifestHref, param, token }) {
  if (!doc || !token) return null;
  const manifest = buildLaunchManifest(base, { href, manifestHref, param, token });
  const dataUrl =
    "data:application/manifest+json;charset=utf-8," + encodeURIComponent(JSON.stringify(manifest));
  let link = doc.querySelector('link[rel="manifest"]');
  if (!link) {
    link = doc.createElement("link");
    link.setAttribute("rel", "manifest");
    const head = doc.head || (doc.getElementsByTagName && doc.getElementsByTagName("head")[0]);
    if (head) head.appendChild(link);
  }
  link.setAttribute("href", dataUrl);
  return dataUrl;
}
