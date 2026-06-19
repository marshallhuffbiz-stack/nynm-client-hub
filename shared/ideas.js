// Proactive idea suggestions + campaign packs — pure, DOM-free logic shared by the
// portal (rendering/API live there). Unit-tested in ideas.test.mjs. No I/O.
//
// Two client-facing features ride on this:
//   #1 "Relay nudges them with ideas": timely post suggestions (upcoming events the
//      client added, upcoming local-business holidays, and posting-gap reminders).
//   #5 "Campaign packs": a holiday idea can expand into a 3-post run (teaser / offer /
//      day-of) created in one tap. buildCampaign() returns the request payloads.

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

/* ---------- date helpers (local midnight, deterministic) ---------- */
function nthWeekday(year, month0, weekday, n) {
  const first = new Date(year, month0, 1);
  const offset = (7 + weekday - first.getDay()) % 7;
  return new Date(year, month0, 1 + offset + (n - 1) * 7);
}
function lastWeekday(year, month0, weekday) {
  const last = new Date(year, month0 + 1, 0);
  const offset = (7 + last.getDay() - weekday) % 7;
  return new Date(year, month0, last.getDate() - offset);
}
function thanksgiving(year) { return nthWeekday(year, 10, 4, 4); } // Nov, Thursday, 4th
function toISO(d) {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}
function parseISO(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ""));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}
function dayDiff(from, to) { return Math.round((to - from) / 86400000); }
export function prettyDate(iso) {
  const d = parseISO(iso);
  return d ? `${MONTHS[d.getMonth()]} ${d.getDate()}` : "";
}
function relDays(days) {
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}
function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

/* ---------- the observance calendar (local-business moments) ---------- */
export const OBSERVANCES = [
  { id: "newyear", label: "New Year's Day", when: { kind: "fixed", month: 1, day: 1 },
    blurb: "A fresh-start moment your customers feel too.",
    postIdea: "Share a short, warm note to start the year and remind people you are open." },
  { id: "valentines", label: "Valentine's Day", when: { kind: "fixed", month: 2, day: 14 },
    blurb: "One of the biggest small-gift and date-night days of the year.",
    postIdea: "Offer a Valentine's idea, a couples special, or a last-minute gift people can grab from you.",
    campaign: { teaser: "Plant the idea early: a Valentine's special or gift is coming.",
      offer: "Make the offer clear, with what it is and how to get it.",
      dayof: "A friendly last-call for anyone still planning their Valentine's." } },
  { id: "stpat", label: "St. Patrick's Day", when: { kind: "fixed", month: 3, day: 17 },
    blurb: "A light, festive reason to post.",
    postIdea: "Share something festive for St. Patrick's Day, a green-themed special or a fun photo." },
  { id: "mothers", label: "Mother's Day", when: { kind: "nth", month: 5, weekday: 0, n: 2 },
    blurb: "A top day for gifts, meals, and treating mom.",
    postIdea: "Give people a Mother's Day idea: a gift, a treat, or a reason to bring mom in.",
    campaign: { teaser: "Remind people Mother's Day is coming and you can help.",
      offer: "Spell out the Mother's Day gift or special and how to get it.",
      dayof: "A warm Happy Mother's Day and a last chance to grab something." } },
  { id: "memorial", label: "Memorial Day", when: { kind: "last", month: 5, weekday: 1 },
    blurb: "A long weekend; people want to know who is open.",
    postIdea: "Post your Memorial Day weekend hours and any holiday-weekend special." },
  { id: "fathers", label: "Father's Day", when: { kind: "nth", month: 6, weekday: 0, n: 3 },
    blurb: "A reason to reach the dads in your customers' lives.",
    postIdea: "Share a Father's Day gift idea, a special, or a simple thank-you to the dads who come in.",
    campaign: { teaser: "Let people know Father's Day is coming and you have ideas.",
      offer: "Show the Father's Day gift or special clearly, with how to get it.",
      dayof: "A friendly Happy Father's Day and a last-minute option for stragglers." } },
  { id: "july4", label: "Fourth of July", when: { kind: "fixed", month: 7, day: 4 },
    blurb: "A holiday weekend; hours and any special matter.",
    postIdea: "Post your Fourth of July hours and a holiday note or special.",
    campaign: { teaser: "Tease your Fourth of July hours and any holiday plan.",
      offer: "Share the holiday special or what you have going on.",
      dayof: "A short Happy Fourth and your hours for the day." } },
  { id: "labor", label: "Labor Day", when: { kind: "nth", month: 9, weekday: 1, n: 1 },
    blurb: "End-of-summer long weekend.",
    postIdea: "Share your Labor Day weekend hours and any end-of-summer special." },
  { id: "halloween", label: "Halloween", when: { kind: "fixed", month: 10, day: 31 },
    blurb: "A fun, photo-friendly day people love to engage with.",
    postIdea: "Post something for Halloween: a treat, a costume photo, or a fun question for your followers.",
    campaign: { teaser: "Build a little Halloween anticipation with what you have planned.",
      offer: "Share the Halloween treat, deal, or event.",
      dayof: "A Happy Halloween post, ideally with a photo from the day." } },
  { id: "thanksgiving", label: "Thanksgiving", when: { kind: "nth", month: 11, weekday: 4, n: 4 },
    blurb: "A moment for gratitude and for posting your holiday hours.",
    postIdea: "Share a genuine thank-you to your customers and your Thanksgiving hours." },
  { id: "blackfriday", label: "Black Friday", when: { kind: "thxOffset", days: 1 },
    blurb: "The biggest sale day of the year.",
    postIdea: "Share your Black Friday deal clearly, with what it is and how long it lasts.",
    campaign: { teaser: "Tease the Black Friday deal a few days out so people plan for it.",
      offer: "Spell out the Black Friday deal and the hours.",
      dayof: "A go-time post that the deal is live now." } },
  { id: "smallbiz", label: "Small Business Saturday", when: { kind: "thxOffset", days: 2 },
    blurb: "The day made for shops exactly like yours.",
    postIdea: "Ask your community to shop small with you, and give them a reason to come in.",
    campaign: { teaser: "Remind people Small Business Saturday is coming and you are part of it.",
      offer: "Give a shop-small reason: a deal, a freebie, or something special.",
      dayof: "A thank-you-for-shopping-small post during the day." } },
  { id: "christmas", label: "Christmas", when: { kind: "fixed", month: 12, day: 25 },
    blurb: "Gifts, gatherings, and holiday hours all matter now.",
    postIdea: "Share a gift idea or your holiday hours, and a warm note to your customers.",
    campaign: { teaser: "Start early with gift ideas and your holiday schedule.",
      offer: "Make the gift or holiday special and the order-by date clear.",
      dayof: "A simple, warm Merry Christmas and your hours." } },
];

function resolveObservance(o, year) {
  const w = o.when;
  if (w.kind === "fixed") return new Date(year, w.month - 1, w.day);
  if (w.kind === "nth") return nthWeekday(year, w.month - 1, w.weekday, w.n);
  if (w.kind === "last") return lastWeekday(year, w.month - 1, w.weekday);
  if (w.kind === "thxOffset") { const t = thanksgiving(year); return new Date(year, 10, t.getDate() + w.days); }
  return null;
}

// Observances whose next occurrence falls within `within` days of `now`.
export function upcomingObservances(now, within) {
  const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const out = [];
  for (const o of OBSERVANCES) {
    for (const yr of [day0.getFullYear(), day0.getFullYear() + 1]) {
      const d = resolveObservance(o, yr);
      if (!d) continue;
      const days = dayDiff(day0, d);
      if (days >= 0 && days <= within) { out.push({ o, iso: toISO(d), days }); break; }
    }
  }
  return out;
}

/* ---------- the suggestions ---------- */
// data: { requests, events }. now: a Date. Returns up to `max` idea objects.
export function computeIdeas(data, now, max = 3) {
  const reqs = Array.isArray(data && data.requests) ? data.requests : [];
  const evts = Array.isArray(data && data.events) ? data.events : [];
  const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const ideas = [];

  // 1) Events the client already added, coming up soon and not yet promoted.
  for (const e of evts) {
    const d = parseISO(e && e.date);
    if (!d) continue;
    const days = dayDiff(day0, d);
    if (days < 0 || days > 14 || e.promoted) continue;
    ideas.push({
      kind: "event", type: "post", priority: 100 - days,
      label: e.title || "your event", date: e.date,
      title: `Promote "${e.title || "your event"}"`,
      detail: `Your event is ${relDays(days)}. A post now helps fill the room.`,
      postIdea: `Let people know about ${e.title || "our event"} on ${prettyDate(e.date)}${e.time ? ` at ${e.time}` : ""}. ${e.description || ""}`.trim(),
    });
  }

  // 2) Upcoming local-business holidays (next 28 days), with optional campaign packs.
  for (const u of upcomingObservances(day0, 28)) {
    ideas.push({
      kind: "holiday", type: "post", priority: 60 - u.days,
      label: u.o.label, date: u.iso, campaign: u.o.campaign || null,
      title: u.o.label,
      detail: `${cap(relDays(u.days))}. ${u.o.blurb}`,
      postIdea: `${u.o.postIdea} (${prettyDate(u.iso)})`,
    });
  }

  // 3) Posting gap — nudge if it has been quiet.
  const times = reqs.map((r) => Date.parse(r && r.createdAt)).filter((t) => !Number.isNaN(t));
  const last = times.length ? Math.max(...times) : null;
  const gap = last ? Math.floor((now.getTime() - last) / 86400000) : null;
  if (last === null || gap >= 10) {
    ideas.push({
      kind: "gap", type: "post", priority: 20,
      title: last === null ? "Let's get you posting" : "It has been a quiet stretch",
      detail: last === null
        ? "A first post is the hardest. Something simple gets the ball rolling."
        : `Your last request was ${gap} days ago. A quick post keeps you visible.`,
      postIdea: "Share something new this week: a special, a photo from today, or a quick hello to your regulars.",
    });
  }

  ideas.sort((a, b) => b.priority - a.priority);
  return ideas.slice(0, max);
}

// Expand a holiday idea into the 3 post requests of a campaign pack.
export function buildCampaign(idea) {
  if (!idea || !idea.campaign) return [];
  const when = idea.date ? prettyDate(idea.date) : "";
  const c = idea.campaign;
  return [
    { type: "post", title: `${idea.label}: teaser`, description: `Teaser post for ${idea.label} (${when}), to publish about a week before. ${c.teaser}` },
    { type: "post", title: `${idea.label}: offer`, description: `Offer post for ${idea.label} (${when}), to publish two or three days before. ${c.offer}` },
    { type: "post", title: `${idea.label}: day of`, description: `Day-of post for ${idea.label} on ${when}. ${c.dayof}` },
  ];
}
