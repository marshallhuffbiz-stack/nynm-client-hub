// worker/wb-core.mjs — pure patch-building for wb.mjs (the drain's writeback CLI).
// Split out so it is unit-testable: wb.mjs itself reads worker/config.json at import
// time and can't be loaded in a test.

// The error writeback must MERGE into the row's existing meta, not clobber it.
// The backend overlays `meta` wholesale on update, so a bare `meta: { run }` wipes
// meta.thread (the client<->team conversation), meta.activity (audit trail),
// meta.notified (→ duplicate "new request" push next tick), meta.clientRequestId
// (submit idempotency) and meta.autoEvent. The shipper got this exact fix in
// faa773c (publish.mjs spreads baseMeta); this is the same pattern for wb.mjs.
// Prior run fields (requeues counter, skill, …) are preserved too, with the error
// fields overlaid. phase:"draft" marks this as a pre-approval failure so a requeue
// re-drafts (see core/model.mjs planRequeue).
export function errorPatch(currentMeta, message, nowIso = new Date().toISOString()) {
  const meta = currentMeta && typeof currentMeta === "object" ? currentMeta : {};
  const run = meta.run && typeof meta.run === "object" ? meta.run : {};
  return {
    action: "error",
    meta: {
      ...meta,
      run: { ...run, status: "error", phase: "draft", error: message || "drain error", finishedAt: nowIso },
    },
  };
}
