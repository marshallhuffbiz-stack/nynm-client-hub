// worker/auto-events.mjs — the Eats on 601 date automation orchestration.
// When a fresh request names a date: extract it (Opus), push the vendor/event onto the
// website, and queue a FULLY-AUTOMATIC day-of post (no approval gate). Once the drain
// has drafted it, auto-approve with the 8 AM-day-of schedule so the shipper publishes it.
//
// Everything here is dependency-injected (extract, syncSite, apiUpdate, notifier) so the
// orchestration is unit-tested without a model, git, or network.
import { mightHaveDate, isConfident, buildSiteEvent, dayOfPostIso, eventKey } from "./events-auto.mjs";

const AUTO_TYPES = new Set(["post", "event-promo", "design"]);

// Fresh requests for the auto client that plausibly name a date and haven't been
// auto-checked yet (no meta.autoEvent).
export function autoEventCandidates(requests, clientId) {
  return (requests || []).filter(
    (r) =>
      r &&
      r.clientId === clientId &&
      r.stage === "submitted" &&
      AUTO_TYPES.has(r.type) &&
      !(r.meta && r.meta.autoEvent) &&
      mightHaveDate(`${r.title || ""}. ${r.description || ""}`)
  );
}

// Extract each candidate; confident → site + auto-queued day-of post; not confident →
// mark checked (so we don't re-spend Opus) and let the normal manual flow handle it.
export async function processAutoEvents({
  apiBase,
  adminToken,
  requests,
  autoClientId,
  extract,
  syncSite,
  apiUpdate,
  notifier,
  now = () => new Date(),
  cap = 3,
}) {
  const cands = autoEventCandidates(requests, autoClientId).slice(0, cap);
  const queuedIds = [];
  let queued = 0;
  let skipped = 0;
  let errored = 0;

  for (const r of cands) {
    const base = r.meta && typeof r.meta === "object" ? r.meta : {};
    let ex;
    try {
      ex = await extract(`${r.title || ""}. ${r.description || ""}`.trim());
    } catch (e) {
      ex = { hasDate: false, confident: false, error: true };
    }

    if (ex && ex.error) {
      // Transient extraction failure (model auth/API error, network). Leave the request
      // UNTOUCHED so it retries on a later tick once the issue clears — don't mark it
      // "checked" (that would falsely retire it).
      errored += 1;
      continue;
    }

    if (!isConfident(ex, now())) {
      await apiUpdate(apiBase, adminToken, r.id, {
        meta: { ...base, autoEvent: { checked: true, confident: false, at: now().toISOString() } },
      });
      skipped += 1;
      continue;
    }

    const entry = buildSiteEvent(ex);
    let site = { ok: false };
    try {
      site = await syncSite(entry);
    } catch (e) {
      site = { ok: false, reason: e && e.message ? e.message : String(e) };
    }

    const scheduledFor = dayOfPostIso(ex.ymd);
    const time = ex.timeStart ? `, ${ex.timeStart}${ex.timeEnd ? `–${ex.timeEnd}` : ""}` : "";
    const comment = `AUTO day-of post: publishes the morning of ${ex.ymd}. Write it as a "today on the lot" announcement for ${entry.title}${time}. Keep it short and on-brand.`;

    await apiUpdate(apiBase, adminToken, r.id, {
      action: "send", // submitted -> queued: auto-queue for drafting, no manual "Send"
      comment,
      meta: {
        ...base,
        autoEvent: {
          key: eventKey(autoClientId, ex.ymd, entry.title),
          ymd: ex.ymd,
          scheduledFor,
          autoApprove: true,
          site: { ok: !!site.ok, changed: !!site.changed, reason: site.reason || "" },
          at: now().toISOString(),
        },
      },
    });
    if (notifier && notifier.notifyAutoEvent) await notifier.notifyAutoEvent({ req: r, entry, scheduledFor, site });
    queued += 1;
    queuedIds.push(r.id);
  }
  return { queued, skipped, errored, queuedIds };
}

// Auto-events whose draft is staged (ready) and not yet approved.
export function autoApproveReadyCandidates(requests) {
  return (requests || []).filter(
    (r) => r && r.stage === "ready" && r.meta && r.meta.autoEvent && r.meta.autoEvent.autoApprove === true && !r.meta.autoEvent.approved
  );
}

// Approve staged auto-event drafts with the day-of schedule so the shipper publishes
// them at 8 AM on the event day — no human approval. Idempotent (meta.autoEvent.approved).
export async function autoApproveReady({ apiBase, adminToken, requests, apiUpdate, now = () => new Date() }) {
  const cands = autoApproveReadyCandidates(requests);
  let approved = 0;
  for (const r of cands) {
    const ae = r.meta.autoEvent;
    const draft = { ...(r.draft || {}), scheduledFor: ae.scheduledFor };
    await apiUpdate(apiBase, adminToken, r.id, {
      action: "approve",
      draft,
      meta: { ...r.meta, autoEvent: { ...ae, approved: true, approvedAt: now().toISOString() } },
    });
    approved += 1;
  }
  return { approved };
}

// Bundle process + autoApprove with bound deps for the poller to inject as one object.
export function makeAutoEvents({ autoClientId, extract, syncSite, apiUpdate, notifier, now = () => new Date(), cap = 3 }) {
  return {
    process: ({ apiBase, adminToken, requests }) =>
      processAutoEvents({ apiBase, adminToken, requests, autoClientId, extract, syncSite, apiUpdate, notifier, now, cap }),
    autoApprove: ({ apiBase, adminToken, requests }) =>
      autoApproveReady({ apiBase, adminToken, requests, apiUpdate, now }),
  };
}
