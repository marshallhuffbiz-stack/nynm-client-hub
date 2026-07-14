// worker/cancel-posts.mjs — the "they canceled" announcement lane.
// The portal's Food Trucks surface lets the client mark a booked truck as canceled;
// that action flips the booking to status:"cancelled" AND submits a `type:"post"`
// request carrying a deterministic clientRequestId marker (`<clientId>-cancel-<bookingId>`,
// idempotent — a double-tap dedupes server-side). This lane finds those submitted
// requests and auto-queues them into the EXISTING pipeline: drain drafts the branded
// announcement → auto-events' autoApproveReady approves (only when the config flag says
// so) → the shipper publishes to the client's Postiz channels.
//
// Unlike the daily/monthly lanes this is NOT time-gated: a cancellation is time-sensitive,
// so it queues on the first tick after the client taps the button, with scheduledFor = now
// (publishTimes clamps to its small lead + stagger).
//
// autoApprove defaults FALSE ("nothing ships without Marshall's approval in the Desk");
// set `schedule.autoApproveCancelPosts: true` in the site's config block to go fully
// hands-off. The marker lives in meta.clientRequestId, which handleSubmitRequest_ writes
// server-side — a client can never plant meta.autoEvent/autoApprove directly.

const MARKER = "-cancel-";

// The deterministic clientRequestId the portal sends when announcing a cancellation.
export function cancelCrid(clientId, bookingId) {
  return `${clientId}${MARKER}${bookingId}`;
}

// True when a request was created by the portal's "they canceled" action.
export function isCancellationRequest(r) {
  const crid = r && r.meta && r.meta.clientRequestId;
  return typeof crid === "string" && crid.includes(MARKER);
}

// Fresh (still-submitted) cancellation posts for this client that no lane has touched yet.
export function cancelPostCandidates(requests, clientId) {
  return (requests || []).filter(
    (r) =>
      r &&
      r.clientId === clientId &&
      r.stage === "submitted" &&
      r.type === "post" &&
      isCancellationRequest(r) &&
      !(r.meta && r.meta.autoEvent)
  );
}

// Resolve the canceled booking for a request via the crid's bookingId. Registry name
// wins over the booking's snapshot (a rename may have landed since).
function resolveBooking(r, bookings, vendors) {
  const crid = (r.meta && r.meta.clientRequestId) || "";
  const bookingId = crid.slice(crid.indexOf(MARKER) + MARKER.length);
  const booking = (bookings || []).find((b) => b && b.id === bookingId) || null;
  if (!booking) return { booking: null, name: "" };
  const reg = (vendors || []).find((v) => v && v.id === booking.vendorId);
  return { booking, name: (reg && reg.name) || booking.vendorName || "" };
}

// Queue every candidate: submitted -> queued (action:"send") with the auto-markers the
// drain / autoApproveReady / shipper already understand. Fail-soft per request.
export async function runCancelPosts({ all, updateRequest, now = new Date(), config = {}, clientId, log = console.error }) {
  const summary = { cancelQueued: 0, cancelFailed: 0 };
  const cands = cancelPostCandidates((all && all.requests) || [], clientId);

  for (const r of cands) {
    const { booking, name } = resolveBooking(r, all && all.bookings, all && all.vendors);
    const who = name || r.title || "a booked truck";
    const when = booking && booking.date ? ` for ${booking.date}` : "";
    const comment =
      `AUTO cancellation post: publish ASAP — ${who} has canceled${when}. ` +
      `Create a branded cancellation announcement graphic + a short, apologetic, on-brand caption. ` +
      `If the request description lists other trucks still coming that day, mention them so the post ends on a positive note.`;

    const patch = {
      action: "send",
      comment,
      meta: {
        ...(r.meta || {}),
        autoEvent: {
          key: (r.meta && r.meta.clientRequestId) || cancelCrid(clientId, "unknown"),
          kind: "cancellation",
          ymd: (booking && booking.date) || "",
          scheduledFor: now.toISOString(), // ASAP — publishTimes adds its own small lead
          autoApprove: !!config.autoApproveCancelPosts,
          at: now.toISOString(),
        },
      },
    };

    try {
      await updateRequest(r.id, patch);
      summary.cancelQueued += 1;
    } catch (e) {
      summary.cancelFailed += 1;
      log(new Date().toISOString(), `cancel-post[${clientId}] ${r.id}: FAILED (caught, batch continues) — ${e && e.message ? e.message : String(e)}`);
    }
  }
  return summary;
}
