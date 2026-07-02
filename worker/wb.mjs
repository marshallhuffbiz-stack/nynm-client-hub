// CLI the headless Claude drain calls to write results back to the API.
//   node worker/wb.mjs start <id>                 # queued/changes -> drafting
//   node worker/wb.mjs ready <id> <draft.json>    # drafting -> ready (+ stage the draft)
//   node worker/wb.mjs ship  <id>                 # approved -> shipping
//   node worker/wb.mjs done  <id>                 # shipping -> done
//   node worker/wb.mjs error <id> "<message>"     # mark failed
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { apiUpdate, apiUpload, apiFetchAll } from "./writeback.mjs";
import { errorPatch } from "./wb-core.mjs";
import { makeNotifier } from "./notify.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(await readFile(join(HERE, "config.json"), "utf8"));
const [, , cmd, id, arg] = process.argv;

// If a draft points at a locally-rendered image, upload it and swap imageUrl for
// the hosted URL so the Desk can preview it. Keeps the local path in artifactPath.
async function uploadDraftImage(draft) {
  const local = draft && (draft.artifactPath || draft.imageUrl);
  if (!local || /^(https?:|data:)/.test(local)) return draft;
  const abs = resolve(HERE, "..", local);
  if (!existsSync(abs)) return draft;
  try {
    const buf = await readFile(abs);
    const lower = local.toLowerCase();
    const mime = lower.endsWith(".png") ? "image/png" : /\.jpe?g$/.test(lower) ? "image/jpeg" : "application/octet-stream";
    const res = await apiUpload(cfg.execUrl, cfg.adminToken, { name: basename(local), mime, dataBase64: buf.toString("base64") });
    if (res && res.ok && res.url) {
      draft.artifactPath = local;
      draft.imageUrl = res.url;
    }
  } catch {
    /* leave the local path; the Desk just won't preview it */
  }
  return draft;
}
if (!cmd || !id) {
  console.error("usage: wb.mjs <start|ready|ship|done|error> <id> [arg]");
  process.exit(2);
}

let patch;
switch (cmd) {
  case "start":
    patch = { action: "start" };
    break;
  case "ready": {
    let draft = {};
    if (arg) draft = existsSync(arg) ? JSON.parse(await readFile(arg, "utf8")) : JSON.parse(arg);
    draft = await uploadDraftImage(draft);
    patch = { action: "ready", draft };
    break;
  }
  case "ship":
    patch = { action: "ship" };
    break;
  case "done":
    patch = { action: "done" };
    break;
  case "error": {
    // Fetch the row first and MERGE into its current meta — a bare meta:{run} would
    // clobber the thread/activity/notified/idempotency fields (see wb-core.mjs).
    // If the fetch fails we still write the error with what we have (an un-merged
    // error beats a silently missing one).
    let currentMeta = {};
    try {
      const all = await apiFetchAll(cfg.execUrl, cfg.adminToken);
      const row = all && Array.isArray(all.requests) ? all.requests.find((r) => r.id === id) : null;
      if (row && row.meta && typeof row.meta === "object") currentMeta = row.meta;
    } catch {}
    patch = errorPatch(currentMeta, arg);
    break;
  }
  default:
    console.error("unknown cmd", cmd);
    process.exit(2);
}

const res = await apiUpdate(cfg.execUrl, cfg.adminToken, id, patch);

// A staged draft is the moment Marshall can act — push it to his phone. Best-effort:
// a failed push must never fail the writeback (the draft is already staged).
if (cmd === "ready" && res && res.ok !== false) {
  try {
    const row = res.request || {};
    await makeNotifier(cfg).notifyReady({
      clientId: row.clientId || "",
      title: row.title || (patch.draft && patch.draft.caption ? String(patch.draft.caption).slice(0, 60) : "draft"),
    });
  } catch { /* non-fatal */ }
}

console.log(JSON.stringify(res));
process.exit(res.ok ? 0 : 1);
