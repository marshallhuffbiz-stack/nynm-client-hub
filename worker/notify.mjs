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

// Canonical Request Desk URL (GH Pages) for notification deep-links. Deliberately
// carries NO admin key — the Desk restores its token from localStorage, so the
// push channel never sees a secret. Override per-install via config.push.click.
export const DESK_URL = "https://marshallhuffbiz-stack.github.io/nynm-client-hub/desk/";

// Pure: the ntfy header set for one push. Every push deep-links to the Desk via
// Click (tapping the notification opens the queue instead of the ntfy app);
// urgent failures additionally get Priority high + a warning tag so they cut
// through. Config-level push.headers always win last.
export function ntfyHeaders(title, { click = DESK_URL, urgent = false, extra } = {}) {
  return {
    Title: title,
    Click: click,
    ...(urgent ? { Priority: "high", Tags: "warning" } : {}),
    ...(extra || {}),
  };
}

// Generic phone push. Supported config.push shapes:
//   { mode: "ntfy", url: "https://ntfy.sh/your-topic", click?: "https://…" }  // headers via ntfyHeaders()
//   { mode: "json", url: "https://…", headers?: {} }         // POST {title,message,click,urgent}
//   { mode: "off" } or absent                                 // no-op
// opts.urgent marks error/failure pushes (high priority + warning tag on ntfy).
export async function pushNotify(push, title, message, opts = {}) {
  if (!push || !push.url || push.mode === "off") return false;
  const click = push.click || DESK_URL;
  const urgent = !!opts.urgent;
  try {
    if (push.mode === "ntfy") {
      await fetch(push.url, {
        method: "POST",
        headers: ntfyHeaders(title, { click, urgent, extra: push.headers }),
        body: message,
      });
    } else {
      await fetch(push.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(push.headers || {}) },
        body: JSON.stringify({ title, message, click, urgent }),
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
    async notifyReady(req) {
      const title = "Draft ready for your review";
      const msg = `${req.clientId}: "${req.title}" is staged on the Desk. Tap to review and approve.`;
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
    async notifyBlocked({ freeMB, count }) {
      const title = "Relay worker paused";
      const msg = `The Mac is low on disk (${freeMB} MB free). ${count} post${count === 1 ? "" : "s"} flagged. Free space, then tap Retry on the Desk.`;
      await macNotify(title, msg);
      await pushNotify(push, title, msg, { urgent: true });
    },
    async notifyShipped({ req, channels }) {
      const title = "Relay — published";
      const where = (channels || [])
        .map((c) => (c === "facebook" ? "Facebook" : c === "instagram" ? "Instagram" : c))
        .join(" + ") || "social";
      const msg = `${req.clientId}: "${req.title || req.type}" is live on ${where}.`;
      await macNotify(title, msg);
      await pushNotify(push, title, msg);
    },
    async notifyShipFailed({ req, error }) {
      const title = "Relay — publish failed";
      const msg = `${req.clientId}: "${req.title || req.type}" didn't publish. ${error || ""}`.trim();
      await macNotify(title, msg);
      await pushNotify(push, title, msg, { urgent: true });
    },
    async notifyAutoEvent({ entry, scheduledFor, site }) {
      const title = "Relay — event auto-scheduled";
      const siteMsg = site && site.ok ? (site.changed ? "added to the website" : "already on the website") : "website update needs a look";
      let when = "";
      try {
        when = scheduledFor ? new Date(scheduledFor).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
      } catch {}
      const msg = `${entry.title} (${entry.date}): ${siteMsg}; day-of post scheduled${when ? ` for ${when} ET` : ""}. Cancel in Postiz if needed.`;
      await macNotify(title, msg);
      await pushNotify(push, title, msg);
    },
  };
}
