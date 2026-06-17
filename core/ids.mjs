import { randomBytes } from "node:crypto";

// req_<base36 time>_<hex rand> — sortable-ish, collision-resistant, human-greppable.
export function genId(prefix = "id") {
  const t = Date.now().toString(36);
  const r = randomBytes(4).toString("hex");
  return `${prefix}_${t}_${r}`;
}

// Secret link / admin token: url-safe alphanumeric, >= len chars (default 24).
export function genToken(len = 24) {
  let s = "";
  while (s.length < len) {
    s += randomBytes(16).toString("base64").replace(/[^a-zA-Z0-9]/g, "");
  }
  return s.slice(0, Math.max(len, 24));
}
