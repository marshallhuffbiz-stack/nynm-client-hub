// Seed the local mock store with pilot clients + a little sample content so the
// Request Desk shows real states on first load. LOCAL/DEV ONLY — tokens here are
// readable dev tokens; production tokens are generated fresh by upsertClient.
import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const storePath = join(root, "data", "store.json");
const now = new Date();
const iso = (d) => new Date(d).toISOString();
const plus = (mins) => iso(now.getTime() + mins * 60000);

const store = {
  settings: { adminToken: "dev-admin", digestHour: 8 },
  clients: [
    { clientId: "the-o", name: "The O", token: "dev-the-o", pin: "", brandSlug: "the-o", postizChannels: [], siteFolder: "", active: true, createdAt: iso(now), updatedAt: iso(now) },
    { clientId: "eats-on-601", name: "Eats on 601", token: "dev-eats", pin: "", brandSlug: "eats-on-601", postizChannels: [], siteFolder: "", active: true, features: { foodTrucks: true }, createdAt: iso(now), updatedAt: iso(now) },
  ],
  requests: [
    {
      id: "req_seed_0001",
      clientId: "the-o",
      type: "post",
      title: "Promote our Friday sidewalk sale",
      description: "Promote our Friday sidewalk sale — 9 to 2, everything 20% off. Use the photos of the front racks.",
      attachments: [],
      eventId: "",
      stage: "submitted",
      comment: "",
      scheduledFor: "",
      draft: null,
      changeNote: "",
      createdAt: plus(-90),
      updatedAt: plus(-90),
      meta: { activity: [{ at: plus(-90), kind: "created", text: "submitted via portal" }] },
    },
    {
      id: "req_seed_0002",
      clientId: "eats-on-601",
      type: "design",
      title: "New weekend specials menu graphic",
      description: "Need a clean graphic for this weekend's specials: smash burger, loaded fries, peach cobbler.",
      attachments: [],
      eventId: "",
      stage: "ready",
      comment: "Keep it in the diner brand, warm tones.",
      scheduledFor: plus(1440),
      draft: {
        caption: "Weekend specials are calling. Smash burger, loaded fries, and peach cobbler — this Friday through Sunday only.",
        imageUrl: "",
        preview: "Diner-brand specials card, warm tones, three featured items.",
        summary: "branded-social-post graphic, staged for approval.",
        channel: "Facebook + Instagram",
      },
      createdAt: plus(-200),
      updatedAt: plus(-15),
      meta: { activity: [
        { at: plus(-200), kind: "created", text: "submitted via portal" },
        { at: plus(-30), kind: "send", text: "sent to Claude" },
        { at: plus(-15), kind: "ready", text: "draft staged (branded-social-post)" },
      ] },
    },
  ],
  events: [
    { eventId: "evt_seed_0001", clientId: "the-o", title: "Live music on the patio", date: "2026-06-20", description: "Local acoustic duo, 7-9pm.", promoted: false, requestId: "", createdAt: iso(now), updatedAt: iso(now) },
  ],
  vendors: [
    { id: "island-boys-food-truck", clientId: "eats-on-601", name: "Island Boys Food Truck", category: "CARIBBEAN", price: "$$", tagline: "Bajan-Caribbean · jerk chicken and island plates", active: true, createdAt: iso(now), updatedAt: iso(now) },
    { id: "bella-sweet-boutique", clientId: "eats-on-601", name: "Bella Sweet Boutique", category: "DESSERTS", price: "$$", tagline: "Small-batch cupcakes, cookies, and sweet treats", active: true, createdAt: iso(now), updatedAt: iso(now) },
    { id: "smokin-bbq-chateau", clientId: "eats-on-601", name: "Smokin BBQ Chateau", category: "BBQ", price: "$$", tagline: "Low-and-slow smoked brisket, ribs, and pulled pork", active: true, createdAt: iso(now), updatedAt: iso(now) },
    { id: "taqueria-el-sol", clientId: "eats-on-601", name: "Taqueria El Sol", category: "TACOS", price: "$", tagline: "Street tacos, elotes, and horchata", active: true, createdAt: iso(now), updatedAt: iso(now) },
  ],
  bookings: [],
};

await mkdir(dirname(storePath), { recursive: true });
await writeFile(storePath, JSON.stringify(store, null, 2));

console.log("Seeded", storePath);
console.log("Admin (Request Desk):  /desk/?k=" + store.settings.adminToken);
for (const c of store.clients) {
  console.log(`Client link [${c.name}]:  /portal/?c=${c.token}` + (c.brandSlug ? "" : "   (no brand folder yet)"));
}
