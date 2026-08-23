// Eats on 601 host-credit enforcement, applied inside the WORKER.
//
// WHY THIS EXISTS (read before "simplifying" it away)
// Driven Creations Custom hosts the Eats on 601 lot. Nikki Christsen asked in writing on
// 2026-08-12 for their logo and the exact words "Hosted by" on everything that goes out.
// The rule lives in brand.json; a gate (check-host-lockup.mjs) checks flyers and captions;
// a PreToolUse hook (~/.claude/hooks/eats-host-credit-guard.mjs) blocks Claude from running
// a bare `postiz posts:create`.
//
// None of that covers THIS lane. The worker spawns the Postiz CLI as a child process from
// launchd/systemd, so no Claude tool call happens and the hook never runs. Audited on
// 2026-08-21: 91 published Eats posts and 38 still-queued ones carried no credit, including
// the Blue Plate daily drop that went out that morning. The hook's own comment says it best:
// a rule that depends on someone remembering to run the checker is not a rule.
//
// DESIGN: repair, don't refuse.
// The credit line is fully deterministic (exact text and placement are specified in
// brand.json), so there is nothing to guess. In an unattended lane, silently dropping the
// client's daily post is a WORSE outcome than posting it with the correct line added. So this
// repairs the caption and reports what it did; the caller is responsible for logging/alerting
// so a repair is loud, not invisible. A repair means an upstream caption generator is still
// wrong and needs fixing at the source.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BRAND = join(homedir(), ".claude", "brands", "eats-on-601", "brand.json");

// Eats on 601 Postiz integration ids. Same literals the PreToolUse hook uses; a command or
// call carrying one of these is posting AS Eats on 601. Kept here (not in config.json) so the
// worker enforces even if a config file is mis-edited.
export const EATS_INTEGRATIONS = {
  cmpbcoidl0007p16a401xgy4a: "facebook", // Eats on 601
  cmph1srif002fp16a180murqx: "instagram", // Eats on 601 · Mocksville Food Trucks
};

// Fallbacks used only if brand.json is unreadable. Never post a bare caption because a file
// failed to open.
const FALLBACK = {
  hostName: "Driven Creations Custom",
  label: "Hosted by",
  creditLine: "Hosted by Driven Creations Custom.",
  creditLineInstagram: "Hosted by Driven Creations Custom (@drivencreationscustom)",
  igHandle: "@drivencreationscustom",
};

// Wording the client explicitly rejected. "Hosted on the lot by" is listed first so it is
// matched before the shorter "Hosted by" substring inside it.
const WRONG_LABELS = ["Hosted on the lot by", "Sponsored by", "Presented by", "Hosted with"];

export function loadHostRule(brandPath = BRAND) {
  try {
    const rule = JSON.parse(readFileSync(brandPath, "utf8"))?.hostCreditRule;
    const cap = rule?.captionRequirement ?? {};
    const host = rule?.host ?? {};
    return {
      hostName: host.name || FALLBACK.hostName,
      label: host.label || FALLBACK.label,
      creditLine: cap.creditLine || FALLBACK.creditLine,
      creditLineInstagram: cap.creditLineInstagram || FALLBACK.creditLineInstagram,
      igHandle: host.instagram ? `@${host.instagram}` : FALLBACK.igHandle,
    };
  } catch {
    return { ...FALLBACK };
  }
}

// A line is part of the trailing hashtag block if it is only hashtags (and whitespace).
function isHashtagLine(line) {
  const t = line.trim();
  return t.length > 0 && /^#[^\s#]+(\s+#[^\s#]+)*$/.test(t);
}

// Insert `credit` on its own line at the end, BEFORE any trailing hashtags.
// brand.json -> hostCreditRule.captionRequirement.placement says exactly this.
//
// Hashtags arrive two ways and BOTH have to be handled. The daily-drop generator ends its
// last sentence with them inline ("...Come see us. #EatsOn601 #Mocksville"), while hand-written
// captions put them on their own trailing line. Only handling the second case is what let the
// first version of this drop the credit BELOW the hashtags, which is the one placement the
// client's rule rules out.
function insertBeforeHashtags(caption, credit) {
  const lines = String(caption ?? "").replace(/\s+$/, "").split("\n");

  // 1. Peel off whole trailing lines that are nothing but hashtags (or blank).
  let cut = lines.length;
  while (cut > 0) {
    const prev = lines[cut - 1];
    if (isHashtagLine(prev) || prev.trim() === "") cut--;
    else break;
  }
  const head = lines.slice(0, cut);
  const tail = lines.slice(cut).filter((l) => l.trim() !== "");

  // 2. The remaining last line may still END in a run of hashtags. Split them off so the
  //    credit lands above them rather than after them.
  if (head.length) {
    const last = head[head.length - 1];
    const m = last.match(/^(.*?)(\s+)(#[^\s#]+(?:\s+#[^\s#]+)*)\s*$/);
    if (m && m[1].trim()) {
      head[head.length - 1] = m[1].replace(/\s+$/, "");
      tail.unshift(m[3]);
    }
  }

  const out = [];
  if (head.length && head.join("").trim()) out.push(head.join("\n").replace(/\s+$/, ""), "");
  out.push(credit);
  if (tail.length) out.push("", tail.join("\n"));
  return out.join("\n");
}

/**
 * Ensure an Eats on 601 caption carries the host credit, in the right wording for the platform.
 *
 * Non-Eats integrations pass through untouched: this is not ours to police.
 *
 * @returns {{caption: string, changed: boolean, action: string, platform: string|null}}
 *   action is one of: "not-eats" | "ok" | "added" | "relabelled" | "stripped-fb-handle"
 *   (multiple repairs report the most significant one; `changed` is the thing to alert on)
 */
export function ensureHostCredit(caption, integrationId, rule = loadHostRule()) {
  const platform = EATS_INTEGRATIONS[integrationId] || null;
  if (!platform) return { caption: String(caption ?? ""), changed: false, action: "not-eats", platform: null };

  let text = String(caption ?? "");
  let action = "ok";

  // 1. Wrong label with the host named ("Sponsored by Driven Creations Custom") is DRIFT,
  //    not omission. Correct the words in place rather than appending a second credit.
  if (text.includes(rule.hostName)) {
    for (const wrong of WRONG_LABELS) {
      if (wrong.toLowerCase() === rule.label.toLowerCase()) continue;
      const re = new RegExp(wrong.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      if (re.test(text)) {
        text = text.replace(re, rule.label);
        action = "relabelled";
      }
    }
  }

  // 2. Facebook must NOT carry the "@" handle. Meta does not grant Page tagging to third-party
  //    schedulers, so an "@" published through Postiz renders as dead literal text and reads as
  //    a broken tag. Strip it to the plain name.
  if (platform === "facebook" && text.includes(rule.igHandle)) {
    text = text
      .replace(new RegExp(`\\s*\\(\\s*${rule.igHandle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\)`, "gi"), "")
      .replace(new RegExp(rule.igHandle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), rule.hostName);
    if (action === "ok") action = "stripped-fb-handle";
  }

  // 3. Present and correctly worded? Done.
  const hasName = text.includes(rule.hostName);
  const hasLabel = new RegExp(rule.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(text);
  if (hasName && hasLabel) {
    return { caption: text, changed: text !== String(caption ?? ""), action, platform };
  }

  // 4. Missing entirely: append the platform-correct line before any hashtag block.
  const credit = platform === "instagram" ? rule.creditLineInstagram : rule.creditLine;
  return { caption: insertBeforeHashtags(text, credit), changed: true, action: "added", platform };
}
