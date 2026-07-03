// shared/history.mjs — session history, pure functions (browser + node).
//
// The backend already appends a meta.activity entry {at, kind, text} on every
// updateRequest action, and accepts patch._note as the entry text (Code.gs
// handleUpdate_). So "session history" = the worker sending rich _note text
// (noteFor) + the Desk flattening every request's activity/thread/draft into
// one searchable timeline (flattenHistory + searchHistory). No backend change.

const trim = (s, n) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

// The _note the worker attaches to each stage transition. Host is in the text so
// Marshall can tell VPS work from Mac work at a glance.
export function noteFor(cmd, { host = "", draft, message } = {}) {
  const on = host ? ` on ${host}` : "";
  switch (cmd) {
    case "start":
      return `Drafting started${on}`;
    case "ready": {
      const text = trim((draft && (draft.summary || draft.caption)) || "", 200);
      const channel = draft && draft.channel ? ` for ${draft.channel}` : "";
      return text ? `Draft staged${channel} — ${text}` : "Draft staged";
    }
    case "ship":
      return `Publish started${on}`;
    case "done":
      return `Published${on}`;
    case "error":
      return `Failed: ${trim(message || "drain error", 200)}`;
    default:
      return trim(message || cmd, 200);
  }
}

const arr = (v) => (Array.isArray(v) ? v : []);

// One flat, searchable timeline across every request: server activity entries,
// client<->team thread messages, the staged draft text, and Marshall's change
// notes. Newest first. Works retroactively on rows created before this feature.
export function flattenHistory(requests, clients) {
  const names = {};
  for (const c of arr(clients)) if (c && c.id) names[c.id] = c.name || c.id;
  const out = [];
  for (const r of arr(requests)) {
    if (!r || !r.id) continue;
    const base = {
      reqId: r.id,
      clientId: r.clientId || "",
      clientName: names[r.clientId] || r.clientId || "",
      title: r.title || "",
      stage: r.stage || "",
    };
    const meta = r.meta && typeof r.meta === "object" ? r.meta : {};
    for (const a of arr(meta.activity)) {
      if (a && (a.text || a.kind)) out.push({ ...base, at: a.at || "", kind: a.kind || "activity", text: String(a.text || a.kind) });
    }
    for (const m of arr(meta.thread)) {
      if (m && m.text) out.push({ ...base, at: m.at || "", kind: "message", text: `${m.from || "note"}: ${m.text}` });
    }
    if (r.draft && (r.draft.caption || r.draft.summary)) {
      out.push({
        ...base,
        at: r.updatedAt || "",
        kind: "draft",
        text: trim([r.draft.summary, r.draft.caption].filter(Boolean).join(" — "), 300),
      });
    }
    if (r.changeNote) out.push({ ...base, at: r.updatedAt || "", kind: "change-note", text: String(r.changeNote) });
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

// Case-insensitive multi-word AND filter over everything a row shows.
export function searchHistory(entries, query) {
  const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return arr(entries);
  return arr(entries).filter((e) => {
    const hay = `${e.text} ${e.title} ${e.clientName} ${e.kind} ${e.stage}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
