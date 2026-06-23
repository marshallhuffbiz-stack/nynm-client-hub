// worker/extract-event.mjs — pull structured event/date info out of a free-text request
// using Opus (so messy phrasing like "this Saturday" / "the 28th" resolves reliably).
// Prompt + parse are pure (unit-tested); the model call is injected.
import { spawn } from "node:child_process";

export function buildExtractPrompt(text, todayYmd) {
  return [
    `Extract event/date info from a small-business social request. Today is ${todayYmd} (America/New_York).`,
    "Return ONLY a single JSON object — no prose, no code fences — with EXACTLY these keys:",
    '{"hasDate":boolean,"confident":boolean,"title":string,"ymd":string,"timeStart":string,"timeEnd":string,"kind":string,"vendor":string,"description":string}',
    "Rules:",
    '- hasDate: true ONLY if the text clearly names one specific calendar date. Resolve relative dates ("this Saturday", "the 28th", "tomorrow") against today. If a range of days, pick the first day.',
    "- confident: true ONLY if you are sure of both the date AND the event/vendor. If anything is ambiguous, set confident:false.",
    "- ymd: the resolved date as YYYY-MM-DD (empty string if hasDate is false).",
    '- title: the vendor or event name (e.g. "AP Southern Kitchen"). kind: "vendor-day" for a food-truck/vendor visit, "event" for a lot event (car show, festival, kickoff).',
    '- timeStart/timeEnd: human times like "11 AM" / "4 PM" if given, else "". description: one short sentence, or "".',
    "If there is no clear single date, return hasDate:false and confident:false.",
    "",
    "REQUEST:",
    text,
  ].join("\n");
}

// Parse the model reply into a normalized object. A reply that ISN'T our schema (empty,
// non-JSON, or an API/auth error payload) returns `error:true` — a TRANSIENT failure the
// caller should retry, NOT a genuine "no date" (which is error:false, hasDate:false).
export function parseExtraction(reply) {
  const err = { hasDate: false, confident: false, error: true };
  if (!reply) return err;
  const s = String(reply);
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return err;
  let obj;
  try {
    obj = JSON.parse(s.slice(a, b + 1));
  } catch {
    return err;
  }
  // Our schema always has a boolean hasDate; an API error JSON ({"type":"error",...})
  // or anything else lacks it → treat as a transient failure, not a real extraction.
  if (!obj || typeof obj !== "object" || typeof obj.hasDate !== "boolean") return err;
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  return {
    hasDate: obj.hasDate === true,
    confident: obj.confident === true,
    title: str(obj.title),
    ymd: str(obj.ymd),
    timeStart: str(obj.timeStart),
    timeEnd: str(obj.timeEnd),
    kind: obj.kind === "event" ? "event" : "vendor-day",
    vendor: str(obj.vendor),
    description: str(obj.description),
    error: false,
  };
}

// extractor(text) -> normalized extraction. `runClaude(prompt)->string` and `today()->ymd`
// are injected so this is testable without spawning a model.
export function makeExtractor({ runClaude, today }) {
  return async (text) => parseExtraction(await runClaude(buildExtractPrompt(text, today())));
}

// Real headless model call (no tools needed — it just returns JSON).
export function makeRunClaude({ claudeBin = "claude", model } = {}) {
  return (prompt) =>
    new Promise((resolve) => {
      const args = ["-p", prompt];
      if (model) args.push("--model", model);
      let out = "";
      try {
        const child = spawn(claudeBin, args, { stdio: ["ignore", "pipe", "ignore"] });
        child.stdout.on("data", (d) => { out += d.toString(); });
        child.on("close", () => resolve(out));
        child.on("error", () => resolve(""));
      } catch {
        resolve("");
      }
    });
}
