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
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(HERE, "..");
const isRemote = (u) => typeof u === "string" && /^(https?:|data:)/i.test(u);

// Channel publishing order — Facebook before Instagram so the stagger fires FB
// first (matches the post skill's anti-burst rule). Unknown providers sort last.
const CHANNEL_ORDER = { facebook: 0, instagram: 1 };
const channelRank = (id) => (id in CHANNEL_ORDER ? CHANNEL_ORDER[id] : 9);

// The Postiz integrations a client publishes to: connected (not disabled) channels
// whose customer name matches the client's name. Sorted FB-first.
export function resolveChannels(integrations = [], clientName) {
  return (integrations || [])
    .filter((i) => i && !i.disabled && i.customer && i.customer.name === clientName)
    .sort((a, b) => channelRank(a.identifier) - channelRank(b.identifier));
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
      mediaUrl = (up && up.url) || up;
      if (!mediaUrl) return { ok: false, error: "Image upload to Postiz returned no URL." };
    }
  } catch (e) {
    return { ok: false, error: "Image upload failed: " + (e && e.message ? e.message : String(e)) };
  }

  const times = publishTimes(channels.length, { scheduledFor: draft.scheduledFor, now });
  const postIds = [];
  try {
    for (let i = 0; i < channels.length; i++) {
      const ch = channels[i];
      const r = await postiz.createPost({
        caption: draft.caption || "",
        mediaUrl,
        isoTime: times[i],
        integrationId: ch.id,
        settings: { post_type: "post" },
      });
      postIds.push({ channel: ch.identifier, integrationId: ch.id, postId: (r && r.postId) || r, at: times[i] });
    }
  } catch (e) {
    return { ok: false, error: "Postiz publish failed: " + (e && e.message ? e.message : String(e)) };
  }

  return { ok: true, channels: channels.map((c) => c.identifier), postIds };
}

// The impure wrapper the poller injects. For each approved ("ship") request it:
//   apiUpdate(action:"ship")  approved -> shipping  (also the idempotency guard:
//     detectJobs only re-picks "approved", so a crash mid-publish never double-posts)
//   shipRequest(...)          publish to the client's channels
//   on ok  -> apiUpdate(action:"done", meta.run)  + notifyShipped
//   on err -> apiUpdate(action:"error", meta.run) + notifyShipFailed
export function makeShipper({ fetchIntegrations, postiz, apiUpdate, notifier, now = () => new Date(), repoRoot = REPO_ROOT }) {
  return async ({ apiBase, adminToken, ships = [], clients = [] }) => {
    let shipped = 0;
    let failed = 0;
    let integrations = [];
    try {
      integrations = (await fetchIntegrations()) || [];
    } catch (e) {
      integrations = [];
    }

    for (const req of ships) {
      const tickNow = now();
      const client = (clients || []).find((c) => c.clientId === req.clientId) || { name: req.clientId };
      await apiUpdate(apiBase, adminToken, req.id, { action: "ship" });

      let result;
      try {
        result = await shipRequest(req, { client, integrations, postiz, now: tickNow, repoRoot });
      } catch (e) {
        result = { ok: false, error: e && e.message ? e.message : String(e) };
      }

      if (result.ok) {
        await apiUpdate(apiBase, adminToken, req.id, {
          action: "done",
          meta: { run: { status: "shipped", finishedAt: tickNow.toISOString(), channels: result.channels, postIds: result.postIds } },
        });
        if (notifier && notifier.notifyShipped) await notifier.notifyShipped({ req, channels: result.channels, postIds: result.postIds });
        shipped += 1;
      } else {
        await apiUpdate(apiBase, adminToken, req.id, {
          action: "error",
          meta: { run: { status: "error", error: result.error, finishedAt: tickNow.toISOString() } },
        });
        if (notifier && notifier.notifyShipFailed) await notifier.notifyShipFailed({ req, error: result.error });
        failed += 1;
      }
    }
    return { shipped, failed };
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
    async createPost({ caption, mediaUrl, isoTime, integrationId, settings }) {
      const args = ["posts:create", "-c", caption, "-s", isoTime, "-i", integrationId, "-t", "schedule", "--settings", JSON.stringify(settings || { post_type: "post" })];
      if (mediaUrl) args.splice(2, 0, "-m", mediaUrl);
      const arr = parseJsonTail(await runPostiz(args), "[");
      return { postId: arr[0] && arr[0].postId };
    },
  };
}
