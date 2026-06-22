// Worker job detection — pure logic, TDD'd in jobs.test.mjs.

// Sort the live request list into the work the worker should do this tick.
export function detectJobs(requests = [], caps = { draft: 5, ship: 5 }) {
  const drafts = [];
  const ships = [];
  const newSubmits = [];
  for (const r of requests) {
    if (r.stage === "queued" || r.stage === "changes") drafts.push(r);
    else if (r.stage === "approved") ships.push(r);
    else if (r.stage === "submitted" && !(r.meta && r.meta.notified)) newSubmits.push(r);
  }
  // Ships are returned UNCAPPED: the poller splits them into social (auto-publish)
  // vs drain lanes and caps each lane independently, so a backlog of one type can't
  // starve the other. Drafts are still capped here (single lane).
  return { drafts: drafts.slice(0, caps.draft), ships, newSubmits };
}

// True if the daily digest is due: now is past `hour` today and we haven't sent
// a digest since today's `hour`.
export function shouldRunDigest(lastRunIso, now, hour) {
  const target = new Date(now);
  target.setHours(hour, 0, 0, 0);
  if (now < target) return false;
  if (!lastRunIso) return true;
  return new Date(lastRunIso) < target;
}
