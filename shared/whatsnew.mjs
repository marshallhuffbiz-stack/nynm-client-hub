// What's-new feed for the client portal: everything that changed for THIS client
// since they last opened the app, computed purely from the portal payload. No new
// backend state — lastSeen lives on the device (localStorage).
//
// Item kinds:
//   ready     — a draft is staged and waiting on the client's review (ALWAYS shown
//               while actionable, regardless of lastSeen; it only leaves the feed
//               when the request moves past `ready`)
//   reply     — a new message from the team on a request's thread
//   published — a social request finished shipping (meta.run.channels)
//   deployed  — a website request is verified live (meta.run.liveUrl)
//
// Returns items sorted newest-first, capped so the feed stays a glance, not a log.

const MAX_ITEMS = 6;

function ts(iso) {
  const t = Date.parse(String(iso || ""));
  return Number.isNaN(t) ? 0 : t;
}

export function computeWhatsNew(data, lastSeenIso, { max = MAX_ITEMS } = {}) {
  const requests = (data && Array.isArray(data.requests)) ? data.requests : [];
  const seen = ts(lastSeenIso);
  const items = [];

  for (const r of requests) {
    if (!r || !r.id) continue;
    const title = r.title || r.description || "your request";
    const meta = r.meta || {};

    // A draft waiting on the client is actionable — always surfaced.
    if (r.stage === "ready" && r.draft) {
      items.push({ kind: "ready", requestId: r.id, at: r.updatedAt || r.createdAt || "", title, fresh: ts(r.updatedAt) > seen });
    }

    // Latest unseen team reply per request (one line per request, not per message).
    const thread = Array.isArray(meta.thread) ? meta.thread : [];
    const reply = thread.filter((m) => m && m.from === "team" && ts(m.at) > seen).pop();
    if (reply) {
      items.push({ kind: "reply", requestId: r.id, at: reply.at, title, text: reply.text, fresh: true });
    }

    // Finished work since last visit.
    const run = meta.run || {};
    if (r.stage === "done" && ts(run.finishedAt) > seen) {
      if (run.liveUrl) {
        items.push({ kind: "deployed", requestId: r.id, at: run.finishedAt, title, liveUrl: run.liveUrl, fresh: true });
      } else if (Array.isArray(run.channels) && run.channels.length) {
        items.push({ kind: "published", requestId: r.id, at: run.finishedAt, title, channels: run.channels, fresh: true });
      }
    }
  }

  items.sort((a, b) => ts(b.at) - ts(a.at));
  return items.slice(0, max);
}

// Count for the PWA app badge: only genuinely-new things (fresh), so the badge
// clears once seen even while an actionable `ready` card stays in the feed.
export function badgeCount(items) {
  return (items || []).filter((i) => i && i.fresh).length;
}
