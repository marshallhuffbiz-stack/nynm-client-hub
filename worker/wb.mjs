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
import { apiUpdate, apiUpload } from "./writeback.mjs";

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
  case "error":
    patch = { action: "error", meta: { run: { status: "error", error: arg || "drain error", finishedAt: new Date().toISOString() } } };
    break;
  default:
    console.error("unknown cmd", cmd);
    process.exit(2);
}

const res = await apiUpdate(cfg.execUrl, cfg.adminToken, id, patch);
console.log(JSON.stringify(res));
process.exit(res.ok ? 0 : 1);
