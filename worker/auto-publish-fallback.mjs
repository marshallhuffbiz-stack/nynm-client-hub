// worker/auto-publish-fallback.mjs — the "Marshall missed the notification" safety net.
// A client post request that nobody acts on within `afterMinutes` of submission is pushed
// forward automatically: `submitted` → sent to the Claude drain (same `action:"send"` the
// Desk button fires); `ready` (draft staged, unapproved) → approved, which publishes via
// the existing deterministic shipper. A warning push fires `warnBeforeMinutes` before the
// deadline so there's a last chance to intervene, and every auto-action pushes when it
// fires — that push is the alerting contract for this automation.
//
// Deliberately conservative:
//   - only the social ship types (post / event-promo) — never design/website work;
//   - requests owned by the auto-events lane (meta.autoEvent.autoApprove) are its business;
//   - rows older than `skipOlderThanHours` are treated as deliberately parked — enabling
//     this lane must never resurrect a graveyard;
//   - a `ready` row with no draft can't be approved into a publishable state — left alone;
//   - `changes` is a live client conversation, not Marshall inaction — left alone;
//   - markers live in meta.autoPublishFallback (server-written only) for idempotency.
//
// On approve, the drafter's judgment `scheduledFor` is STRIPPED from the draft so publish
// falls back to req.scheduledFor (the client's explicit pick) or "now" — a fallback publish
// is already an hour late; it must go out, not sit silently in the Postiz queue overnight
// (the 2026-07-20 incident).
//
// Everything is dependency-injected (apiUpdate, notify) and pure where possible, so the
// whole lane is unit-tested without a network.

const DEFAULTS = {
  enabled: false,
  afterMinutes: 60,
  warnBeforeMinutes: 15,
  types: ["post", "event-promo"],
  skipOlderThanHours: 48,
  capPerTick: 2,
};

// Normalize the config block (cfg.autoPublishFallback from config.json). Absent → disabled.
export function fallbackConfig(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: c.enabled === true,
    afterMinutes: Number(c.afterMinutes) > 0 ? Number(c.afterMinutes) : DEFAULTS.afterMinutes,
    warnBeforeMinutes:
      Number(c.warnBeforeMinutes) >= 0 ? Number(c.warnBeforeMinutes) : DEFAULTS.warnBeforeMinutes,
    types: Array.isArray(c.types) && c.types.length ? c.types.slice() : DEFAULTS.types.slice(),
    skipOlderThanHours:
      Number(c.skipOlderThanHours) > 0 ? Number(c.skipOlderThanHours) : DEFAULTS.skipOlderThanHours,
    capPerTick: Number(c.capPerTick) > 0 ? Number(c.capPerTick) : DEFAULTS.capPerTick,
  };
}

function ageMinutes(r, now) {
  const created = r && r.createdAt ? Date.parse(r.createdAt) : NaN;
  if (Number.isNaN(created)) return null; // unparseable → never eligible (fail closed)
  return (now.getTime() - created) / 60000;
}

function marker(r) {
  return (r.meta && r.meta.autoPublishFallback) || {};
}

// Sort the request list into this tick's fallback work. Pure.
export function fallbackCandidates(requests, cfg, now) {
  const out = { sends: [], approves: [], warns: [] };
  if (!cfg || !cfg.enabled) return out;
  const maxMinutes = cfg.skipOlderThanHours * 60;
  const warnAt = cfg.afterMinutes - cfg.warnBeforeMinutes;

  for (const r of requests || []) {
    if (!r || !cfg.types.includes(r.type)) continue;
    if (r.meta && r.meta.autoEvent && r.meta.autoEvent.autoApprove === true) continue;
    const age = ageMinutes(r, now);
    if (age === null || age > maxMinutes) continue;

    const m = marker(r);
    const actionable =
      (r.stage === "submitted" && !m.sentAt) || (r.stage === "ready" && !!r.draft && !m.approvedAt);
    if (!actionable) continue;

    if (age >= cfg.afterMinutes) {
      if (r.stage === "submitted") out.sends.push(r);
      else out.approves.push(r);
    } else if (age >= warnAt && !m.warnedAt) {
      out.warns.push(r);
    }
  }

  // Oldest first so a backlog drains in arrival order; cap the state-changing lanes.
  const byAge = (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt);
  out.sends = out.sends.sort(byAge).slice(0, cfg.capPerTick);
  out.approves = out.approves.sort(byAge).slice(0, cfg.capPerTick);
  out.warns.sort(byAge);
  return out;
}

const label = (r) => `${r.clientId}: "${r.title || r.type}"`;

// Apply this tick's fallback work. Fail-soft per row: one bad update never blocks the rest.
export async function runAutoPublishFallback({
  apiBase,
  adminToken,
  requests,
  cfg,
  apiUpdate,
  notify,
  now = () => new Date(),
}) {
  const res = { warned: 0, sent: 0, approved: 0, failed: 0 };
  const cands = fallbackCandidates(requests, cfg, now());
  const stamp = () => now().toISOString();
  const mark = (r, patch) => ({ ...(r.meta || {}), autoPublishFallback: { ...marker(r), ...patch } });

  for (const r of cands.warns) {
    try {
      await notify(
        "Relay — auto-publish in ~15 min",
        `${label(r)} has had no action for ${Math.round(cfg.afterMinutes - cfg.warnBeforeMinutes)} min. ` +
          `It auto-publishes in ~${cfg.warnBeforeMinutes} min unless you act in the Desk.`,
        { priority: "high", tags: "hourglass_flowing_sand" }
      );
      await apiUpdate(apiBase, adminToken, r.id, { meta: mark(r, { warnedAt: stamp() }) });
      res.warned += 1;
    } catch (e) {
      res.failed += 1;
      console.error(stamp(), `fallback warn failed for ${r.id}:`, e && e.message ? e.message : String(e));
    }
  }

  for (const r of cands.sends) {
    try {
      await apiUpdate(apiBase, adminToken, r.id, {
        action: "send",
        comment:
          "AUTO-PUBLISH FALLBACK: no human action within the hour, so this was sent to the drain " +
          "automatically and will publish on approval without review. Draft conservatively and " +
          "strictly on-brand.",
        meta: mark(r, { sentAt: stamp() }),
      });
      res.sent += 1;
      await notify(
        "Relay — auto-sent to Claude",
        `${label(r)} sat ${Math.round(cfg.afterMinutes)} min with no action — drafting now; it will auto-publish once staged.`,
        { priority: "high", tags: "robot" }
      );
    } catch (e) {
      res.failed += 1;
      console.error(stamp(), `fallback send failed for ${r.id}:`, e && e.message ? e.message : String(e));
    }
  }

  for (const r of cands.approves) {
    try {
      // Strip the drafter's scheduledFor: publish falls back to req.scheduledFor (client's
      // explicit pick) or now — see header comment.
      const draft = { ...(r.draft || {}) };
      delete draft.scheduledFor;
      await apiUpdate(apiBase, adminToken, r.id, {
        action: "approve",
        draft,
        meta: mark(r, { approvedAt: stamp() }),
      });
      res.approved += 1;
      await notify(
        "Relay — auto-publishing now",
        `${label(r)} was staged but unapproved past the hour — approved automatically and publishing now. Check Postiz to intervene.`,
        { priority: "high", tags: "robot" }
      );
    } catch (e) {
      res.failed += 1;
      console.error(stamp(), `fallback approve failed for ${r.id}:`, e && e.message ? e.message : String(e));
    }
  }

  return res;
}

// Bind deps for the poller: one injectable lane function, config resolved once.
export function makeAutoPublishFallback({ cfg, apiUpdate, push, pushNotify, now = () => new Date() }) {
  const resolved = fallbackConfig(cfg);
  if (!resolved.enabled) return null;
  const notify = (title, message, opts) => pushNotify(push, title, message, opts);
  return ({ apiBase, adminToken, requests }) =>
    runAutoPublishFallback({ apiBase, adminToken, requests, cfg: resolved, apiUpdate, notify, now });
}
