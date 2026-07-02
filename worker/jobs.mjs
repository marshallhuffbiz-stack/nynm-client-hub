// Worker job detection — pure logic, TDD'd in jobs.test.mjs.

// Sort the live request list into the work the worker should do this tick.
export function detectJobs(requests = [], caps = { draft: 5, ship: 5 }) {
  const drafts = [];
  const ships = [];
  const newSubmits = [];
  for (const r of requests) {
    if (r.stage === "queued" || r.stage === "changes") drafts.push(r);
    else if (r.stage === "approved") ships.push(r);
    else if (r.stage === "submitted" && !(r.meta && r.meta.notified)) newSubmits.push(r);
  }
  // Ships are returned UNCAPPED: the poller splits them into social (auto-publish)
  // vs drain lanes and caps each lane independently, so a backlog of one type can't
  // starve the other. Drafts are still capped here (single lane).
  return { drafts: drafts.slice(0, caps.draft), ships, newSubmits };
}

// Enrich raw request rows into drain-brief jobs. Request rows carry no brand info —
// brandSlug/siteFolder live on the Client record — and drain.md tells the drafter an
// empty brandSlug means "clean neutral treatment", so shipping raw rows silently drops
// brand fidelity (and website ships can never see siteFolder). Joining here also
// attaches the promoted event's start/end times so an event promo can actually say
// "7–10 PM" instead of hallucinating.
export function enrichJobs(rows = [], clients = [], events = []) {
  const byClient = new Map((clients || []).map((c) => [c.clientId, c]));
  const byEvent = new Map((events || []).map((e) => [e.eventId, e]));
  return (rows || []).map((r) => {
    const c = byClient.get(r.clientId) || {};
    const job = {
      ...r,
      brandSlug: r.brandSlug || c.brandSlug || "",
      siteFolder: r.siteFolder || c.siteFolder || "",
      clientName: c.name || r.clientId || "",
    };
    const ev = r.eventId ? byEvent.get(r.eventId) : null;
    if (ev) {
      job.event = {
        title: ev.title || "",
        date: ev.date || "",
        time: ev.time || "",
        endTime: ev.endTime || "",
        description: ev.description || "",
      };
    }
    return job;
  });
}

// True if the daily digest is due: now is past `hour` today and we haven't sent
// a digest since today's `hour`.
export function shouldRunDigest(lastRunIso, now, hour) {
  const target = new Date(now);
  target.setHours(hour, 0, 0, 0);
  if (now < target) return false;
  if (!lastRunIso) return true;
  return new Date(lastRunIso) < target;
}

// A 'drafting' row is assumed to be owned by a live Claude drain, and a 'shipping'
// row by a live shipper pass. Worker ticks are serialized by worker/.lock, so any
// such row still present at fetch time is from a PRIOR tick whose run already exited
// (crashed, was killed, ran out of space mid-render, died mid-publish, or lost the
// done-writeback). Nothing else re-queues it, so without this it is stranded forever.
// The age threshold is a safety margin so a legitimately long-running drain/publish
// is never mistaken for an orphan.
const ORPHANABLE = new Set(["drafting", "shipping"]);
export function detectOrphans(requests = [], now = new Date(), maxAgeMs = 15 * 60 * 1000) {
  const t = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const orphans = [];
  for (const r of requests) {
    if (!ORPHANABLE.has(r.stage)) continue;
    const updated = r.updatedAt ? Date.parse(r.updatedAt) : NaN;
    if (Number.isNaN(updated) || t - updated >= maxAgeMs) orphans.push(r);
  }
  return orphans;
}

// Decide what to do with each orphaned row, capped at maxRequeues auto-recoveries so a
// permanently-failing request surfaces a real error instead of looping forever.
//   'drafting' orphan -> back to "queued" (draft wiped; a fresh drain re-drafts it).
//   'shipping' orphan -> back to "approved" (the SHIP lane re-picks it). The approved
//     draft is NEVER wiped and it is never re-drafted — the creative already passed
//     review; only the publish was interrupted. Because the interrupted publish MAY
//     have reached Postiz before dying, the patch carries a run.warning telling the
//     human to check Postiz for a duplicate.
// Returns [{ id, patch }] for the caller to apply via apiUpdate.
export function planOrphanRecovery(orphans = [], maxRequeues = 3) {
  return orphans.map((r) => {
    const run = (r.meta && r.meta.run) || {};
    const tries = Number(run.requeues || 0);
    const shipping = r.stage === "shipping";
    if (tries >= maxRequeues) {
      const error = shipping
        ? `Publish was interrupted ${tries} times and may or may not have completed — check Postiz before retrying.`
        : `Auto-recovery gave up after ${tries} attempts — please resend this request.`;
      return {
        id: r.id,
        patch: { stage: "error", meta: { ...(r.meta || {}), run: { ...run, ...(shipping ? { phase: "publish" } : {}), error } } },
      };
    }
    if (shipping) {
      return {
        id: r.id,
        patch: {
          stage: "approved",
          meta: {
            ...(r.meta || {}),
            run: { ...run, requeues: tries + 1, error: "", phase: "publish", warning: "Recovered from an interrupted publish — verify in Postiz that the post isn't already scheduled." },
          },
        },
      };
    }
    return {
      id: r.id,
      patch: { stage: "queued", draft: null, meta: { ...(r.meta || {}), run: { ...run, requeues: tries + 1, error: "" } } },
    };
  });
}
