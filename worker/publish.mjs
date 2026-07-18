// worker/publish.mjs — deterministic publish of an APPROVED Relay draft to the
// client's Postiz channels. This is the "ship" path: it needs no AI (drafting is
// the creative part; shipping is mechanical), so it runs in plain Node in the
// poller — NOT in the headless Claude drain, which keeps Skill(post) denied.
//
// All I/O is injected (postiz client, apiUpdate, notifier, fetchIntegrations) so
// the orchestration is unit-tested in publish.test.mjs without touching network.
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { homedir, hostname } from "node:os";
import { apiMessage as defaultApiMessage } from "./writeback.mjs";
import { noteFor } from "../shared/history.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(HERE, "..");
const HOST = hostname();
const isRemote = (u) => typeof u === "string" && /^(https?:|data:)/i.test(u);

// Channel publishing order — Facebook before Instagram so the stagger fires FB
// first (matches the post skill's anti-burst rule). Unknown providers sort last.
const CHANNEL_ORDER = { facebook: 0, instagram: 1 };
const channelRank = (id) => (id in CHANNEL_ORDER ? CHANNEL_ORDER[id] : 9);

// Normalize a customer/client name for matching — trim + lowercase so trailing
// spaces or case drift between the Hub and Postiz don't silently yield zero channels.
const normName = (s) => String(s == null ? "" : s).trim().toLowerCase();

// The Postiz integrations a client publishes to: connected (not disabled) channels
// whose customer name matches the client's name (normalized). Sorted FB-first and
// de-duped to one channel per platform.
export function resolveChannels(integrations = [], clientName) {
  const want = normName(clientName);
  if (!want) return [];
  const matched = (integrations || [])
    .filter((i) => i && !i.disabled && i.customer && normName(i.customer.name) === want)
    .sort((a, b) => channelRank(a.identifier) - channelRank(b.identifier));
  const seen = new Set();
  const unique = [];
  for (const i of matched) {
    if (seen.has(i.identifier)) continue;
    seen.add(i.identifier);
    unique.push(i);
  }
  return unique;
}

// Publish times for `count` channels. Base = draft.scheduledFor if it's a valid
// future time, else now + leadMin. Each channel is staggered staggerMin minutes
// later (never two channels in the same minute).
export function publishTimes(count, { scheduledFor, now, leadMin = 3, staggerMin = 6 } = {}) {
  let baseMs = now.getTime() + leadMin * 60000;
  if (scheduledFor) {
    const t = Date.parse(scheduledFor);
    if (!Number.isNaN(t) && t > now.getTime()) baseMs = t;
  }
  return Array.from({ length: count }, (_, i) => new Date(baseMs + i * staggerMin * 60000).toISOString());
}

// Publish one approved request. Returns { ok:true, channels, postIds } or
// { ok:false, error }. Pure orchestration — `postiz` is injected.
export async function shipRequest(req, { client, integrations, postiz, now, repoRoot = REPO_ROOT }) {
  const draft = (req && req.draft) || {};
  const clientName = (client && client.name) || (req && req.clientId) || "";

  const channels = resolveChannels(integrations, clientName);
  if (!channels.length) {
    return { ok: false, error: `No Postiz channels connected for "${clientName}". Connect the client's channels in Postiz, then retry.` };
  }

  // Media: prefer the locally rendered artifact (uploaded to Postiz); a draft that
  // already carries a direct http/data image URL is used as-is. A Drive "view" URL
  // is NOT a usable image, so artifactPath is preferred and uploaded.
  const media = draft.artifactPath || draft.imageUrl;
  if (!media) return { ok: false, error: "No image to publish (draft has no artifactPath or imageUrl)." };

  let mediaUrl;
  try {
    if (isRemote(media)) {
      mediaUrl = media;
    } else {
      const up = await postiz.upload(resolvePath(repoRoot, media));
      mediaUrl = up && up.url;
      if (!mediaUrl) return { ok: false, error: "Image upload to Postiz returned no URL." };
    }
  } catch (e) {
    return { ok: false, error: "Image upload failed: " + (e && e.message ? e.message : String(e)) };
  }

  // Publish each channel independently: a failure on one channel must not discard
  // the channels that already succeeded (else a retry would double-post them).
  // The draft's explicit schedule wins; else honor the time the client picked at
  // submit (request.scheduledFor) so "post this Friday at 6" lands Friday at 6.
  const times = publishTimes(channels.length, { scheduledFor: draft.scheduledFor || req.scheduledFor, now });
  const postIds = [];
  const failures = [];
  for (let i = 0; i < channels.length; i++) {
    const ch = channels[i];
    try {
      const r = await postiz.createPost({
        caption: draft.caption || "",
        mediaUrl,
        isoTime: times[i],
        integrationId: ch.id,
        settings: { post_type: "post" },
      });
      postIds.push({ channel: ch.identifier, integrationId: ch.id, postId: (r && r.postId) || r, at: times[i] });
    } catch (e) {
      failures.push({ channel: ch.identifier, error: e && e.message ? e.message : String(e) });
    }
  }

  // Nothing posted → safe to mark error and retry the whole request (no double-post).
  if (postIds.length === 0) {
    return { ok: false, error: "Postiz publish failed: " + (failures.map((f) => `${f.channel}: ${f.error}`).join("; ") || "unknown") };
  }
  // Some or all posted. Report any partial failures so the shipper can flag them
  // WITHOUT re-posting the channels that already went out.
  return { ok: true, channels: postIds.map((p) => p.channel), postIds, failures };
}

// Client-facing "it's live" message for the request thread. Warm, no em dashes.
// type "post" reads as "your post"; other types read sensibly ("event-promo" →
// "your event promo"). Channels are the ones that ACTUALLY published.
const CHANNEL_LABEL = { facebook: "Facebook", instagram: "Instagram" };
export function composeClientLiveMessage({ type, channels } = {}) {
  const noun = String(type || "post").trim().replace(/-/g, " ") || "post";
  const where = (channels || []).map((c) => CHANNEL_LABEL[c] || c).join(" + ") || "social";
  return `Your ${noun} is live on ${where}. Thanks for sending it our way!`;
}

// The impure wrapper the poller injects. For each approved ("ship") request it:
//   apiUpdate(action:"ship")  approved -> shipping  (also the idempotency guard:
//     detectJobs only re-picks "approved", so a crash mid-publish never double-posts)
//   shipRequest(...)          publish to the client's channels
//   on ok  -> apiUpdate(action:"done", meta.run)  + notifyShipped
//              + apiMessage into the client's request thread ("Your post is live…")
//   on err -> apiUpdate(action:"error", meta.run) + notifyShipFailed
export function makeShipper({ fetchIntegrations, postiz, apiUpdate, apiMessage = defaultApiMessage, notifier, now = () => new Date(), repoRoot = REPO_ROOT }) {
  return async ({ apiBase, adminToken, ships = [], clients = [] }) => {
    let shipped = 0;
    let failed = 0;
    let skipped = 0;
    let integrations = [];
    try {
      integrations = (await fetchIntegrations()) || [];
    } catch (e) {
      // Postiz itself is unreachable (it has real outage history). That is NOT a
      // per-request failure: do not claim, error, or touch ANY row — leave everything
      // 'approved' so the whole lane simply retries next tick once Postiz is back.
      // The old behavior (integrations=[] → "No Postiz channels" → error) nuked
      // approved creatives into the re-draft path over a transient blip.
      console.error(
        `[shipper] Postiz unreachable (${e && e.message ? e.message : e}) — deferring ${ships.length} approved post(s) to the next tick; drafts kept.`
      );
      return { shipped: 0, failed: 0, skipped: ships.length, deferred: true };
    }

    for (const req of ships) {
      const tickNow = now();
      const client = (clients || []).find((c) => c.clientId === req.clientId) || { name: req.clientId };

      // Claim the row (approved -> shipping) BEFORE publishing. If this writeback
      // does not commit, do NOT publish: leave it "approved" to retry next tick,
      // so a failed claim can never lead to a double-post.
      const claim = await apiUpdate(apiBase, adminToken, req.id, { action: "ship", _note: noteFor("ship", { host: HOST }) });
      if (!claim || claim.ok !== true) {
        skipped += 1;
        continue;
      }

      let result;
      try {
        result = await shipRequest(req, { client, integrations, postiz, now: tickNow, repoRoot });
      } catch (e) {
        result = { ok: false, error: e && e.message ? e.message : String(e) };
      }

      // Preserve the row's existing meta (client<->team thread, activity log, the
      // notified flag) — the backend overlays the whole meta object, so a bare
      // meta:{run} would wipe everything else.
      const baseMeta = (req && req.meta) || {};
      if (result.ok) {
        const partial = (result.failures || []).filter(Boolean);
        const donePatch = {
          action: "done",
          _note: `Published to ${(result.channels || []).join(", ") || "social"} (${HOST})`,
          meta: { ...baseMeta, run: { status: partial.length ? "shipped-partial" : "shipped", finishedAt: tickNow.toISOString(), channels: result.channels, postIds: result.postIds, failures: partial } },
        };
        // The post is already scheduled in Postiz here; we only need the row to read
        // "done". Retry the writeback once so a transient blip can't wedge it at
        // "shipping" while notifyShipped has already told Marshall it's live.
        let doneRes = await apiUpdate(apiBase, adminToken, req.id, donePatch);
        if (!doneRes || doneRes.ok !== true) doneRes = await apiUpdate(apiBase, adminToken, req.id, donePatch);
        // Close the client loop: tell the client in their request thread that it's
        // live. Best-effort — a failed thread message must never fail the ship.
        try {
          await apiMessage(apiBase, adminToken, req.id, composeClientLiveMessage({ type: req.type, channels: result.channels }));
        } catch { /* non-fatal */ }
        if (notifier && notifier.notifyShipped) await notifier.notifyShipped({ req, channels: result.channels, postIds: result.postIds });
        if (partial.length && notifier && notifier.notifyShipFailed) {
          await notifier.notifyShipFailed({ req, error: "Some channels didn't post: " + partial.map((f) => f.channel).join(", ") });
        }
        if (!doneRes || doneRes.ok !== true) {
          console.error(`[shipper] ${req.id} published but the done-writeback failed twice — row may sit at "shipping" until reconciled.`);
        }
        shipped += 1;
      } else {
        // phase:"publish" marks this as a POST-approval failure: the draft is intact
        // and a requeue should re-approve (ship again), never wipe + re-draft. See
        // core/model.mjs planRequeue.
        await apiUpdate(apiBase, adminToken, req.id, {
          action: "error",
          _note: noteFor("error", { message: result.error }),
          meta: { ...baseMeta, run: { status: "error", phase: "publish", error: result.error, finishedAt: tickNow.toISOString() } },
        });
        if (notifier && notifier.notifyShipFailed) await notifier.notifyShipFailed({ req, error: result.error });
        failed += 1;
      }
    }
    return { shipped, failed, skipped };
  };
}

// --- Real Postiz client (pure I/O; not unit-tested, exercised in live verify) ---
// Shells out to the same proven CLI the /post skill uses.
const POSTIZ_SH = resolvePath(homedir(), ".claude/skills/post/scripts/postiz.sh");

function runPostiz(args) {
  return new Promise((resolve, reject) => {
    execFile(POSTIZ_SH, args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message || "").toString().trim().slice(0, 400)));
      resolve((stdout || "").toString());
    });
  });
}
// Postiz CLI prints a human header line before its JSON; slice from the first bracket/brace.
function parseJsonTail(out, open) {
  const i = out.indexOf(open);
  if (i < 0) throw new Error("no JSON in postiz output");
  return JSON.parse(out.slice(i));
}

// Build the `posts:create` argv. Flag order is irrelevant to the CLI, so -m is
// appended LAST — the bug to avoid is inserting it between -c and its value,
// which makes the CLI read "-m" as the caption.
export function postsCreateArgs({ caption, mediaUrl, isoTime, integrationId, settings }) {
  const args = ["posts:create", "-c", caption || "", "-s", isoTime, "-i", integrationId, "-t", "schedule", "--settings", JSON.stringify(settings || { post_type: "post" })];
  if (mediaUrl) args.push("-m", mediaUrl);
  return args;
}

export function makePostizClient() {
  return {
    async listIntegrations() {
      return parseJsonTail(await runPostiz(["integrations:list"]), "[");
    },
    async upload(absPath) {
      const out = await runPostiz(["upload", absPath]);
      const d = parseJsonTail(out, "{");
      return { url: d.path || d.url };
    },
    async createPost(opts) {
      const arr = parseJsonTail(await runPostiz(postsCreateArgs(opts)), "[");
      return { postId: arr[0] && arr[0].postId };
    },
  };
}
