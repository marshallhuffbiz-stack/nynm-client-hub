// Notifications: Mac banner (works now) + a pluggable phone-push webhook.
// Point config.push at your existing push path (ntfy, Pushover, a webhook, etc.).
import { execFile } from "node:child_process";

export function macNotify(title, message) {
  return new Promise((resolve) => {
    const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`;
    try {
      execFile("osascript", ["-e", script], () => resolve(true));
    } catch {
      resolve(false);
    }
  });
}

// Generic phone push. Supported config.push shapes:
//   { mode: "ntfy", url: "https://ntfy.sh/your-topic" }     // title via Title header, body = message
//   { mode: "json", url: "https://…", headers?: {} }         // POST {title,message}
//   { mode: "off" } or absent                                 // no-op
export async function pushNotify(push, title, message) {
  if (!push || !push.url || push.mode === "off") return false;
  try {
    if (push.mode === "ntfy") {
      await fetch(push.url, { method: "POST", headers: { Title: title, ...(push.headers || {}) }, body: message });
    } else {
      await fetch(push.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(push.headers || {}) },
        body: JSON.stringify({ title, message }),
      });
    }
    return true;
  } catch {
    return false;
  }
}

export function makeNotifier(config = {}) {
  const push = config.push;
  return {
    async notifyNew(req) {
      const title = "New client request";
      const msg = `${req.clientId}: ${req.title || req.type}`;
      await macNotify(title, msg);
      await pushNotify(push, title, msg);
    },
    async notifyDigest(summary) {
      const title = "Client Hub — daily digest";
      const head = `${summary.open} open request${summary.open === 1 ? "" : "s"}.`;
      const body = summary.lines.length ? head + " " + summary.lines.slice(0, 6).join("; ") : head;
      await macNotify(title, body);
      await pushNotify(push, title, body);
    },
  };
}
