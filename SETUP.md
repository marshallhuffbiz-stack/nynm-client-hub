# Client Hub — setup

Two ways to run it:

- **Local (no Google account needed)** — fully working right now, for trying it and development.
- **Production** — point it at your own Google Sheet, deploy, host the pages, install the worker.

---

## Run locally (works today)

```bash
cd "/Users/MarshallHuff/New General/client-hub"
npm run seed     # seeds 3 pilot clients + sample data into data/store.json
npm run dev      # mock API on :8787, the two PWAs on :8080
npm test         # 27 tests (core + backend contract + worker)
```

Open in a browser:
- **Request Desk (you):** http://127.0.0.1:8080/desk/?k=dev-admin
- **The O portal:** http://127.0.0.1:8080/portal/?c=dev-the-o
- **Eats on 601:** http://127.0.0.1:8080/portal/?c=dev-eats
- **A New Day:** http://127.0.0.1:8080/portal/?c=dev-anewday

Everything works against the local mock backend. Swapping to your real Google backend is the checklist below.

---

## Go live (the deferred checklist)

### 1. Create the Sheet + backend
1. New sheet at **sheets.new**, name it `NYNM Client Hub`.
2. **Extensions → Apps Script.** Delete the stub `Code.gs`, paste in `apps-script/Code.gs`. Open project settings and show `appsscript.json`, paste in ours.
3. Run the `setup` function once (authorize when prompted). It creates the 3 tabs (Clients, Requests, Events), generates an admin token, and makes a `Client Hub Uploads` Drive folder. Idempotent — safe to re-run.
4. Reload the sheet. Use the new **Client Hub → Show admin token** menu to copy your `ADMIN_TOKEN`.
5. **Deploy → New deployment → Web app.** Execute as **Me**, access **Anyone**. Deploy and copy the **`/exec` Web app URL.**

### 2. Point the apps at it (the one-line swap)
Edit `shared/config.js`:
```js
export const API_MODE = "live";
export const API_BASE = "https://script.google.com/macros/s/XXXXXXXX/exec";
```
The browser client already handles live mode (it keys off the JSON body status, since Apps Script always returns HTTP 200).

### 3. Add your clients
- In the sheet: **Client Hub → Seed pilot clients** (creates the-o / eats-on-601 / a-new-day with tokens), then open the **Clients** tab to copy each `token`.
- Or add/edit clients from the **Request Desk → Clients** view.

### 4. Configure the worker
```bash
cd "/Users/MarshallHuff/New General/client-hub/worker"
cp config.example.json config.json
```
In `config.json` set: `execUrl` = your `/exec` URL, `adminToken` = your `ADMIN_TOKEN`, and `push` (point at the same phone push you already use — ntfy topic, Pushover, or a webhook). In the **Clients** sheet, fill each client's `postizChannels` (their Postiz channel ids) and `siteFolder` (absolute path if you host their site).

### 5. Host the PWAs
The portal + desk are static — host the whole `client-hub` folder (needs `portal/`, `desk/`, `shared/`) on any static host: `/publish` (publish-product), GitHub Pages, etc.
- Give each client their link: `https://YOURHOST/portal/?c=<their token>`
- Add the desk to your home screen: `https://YOURHOST/desk/?k=<ADMIN_TOKEN>` — **keep this private; the admin token is in the URL.**

### 6. Install the worker (launchd)
```bash
mkdir -p "/Users/MarshallHuff/New General/client-hub/worker/logs"
cp "/Users/MarshallHuff/New General/client-hub/worker/com.nynm.client-worker.plist" ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nynm.client-worker.plist
launchctl kickstart -k gui/$(id -u)/com.nynm.client-worker
```
It runs every 5 minutes: notifies you of new requests, stages drafts for queued ones, ships approved ones. Watch `worker/logs/out.log` and `worker/logs/err.log`.
- Stop it: `launchctl bootout gui/$(id -u)/com.nynm.client-worker`
- If you change node versions, update the node path in the plist (`which node`).

---

## How it flows
Client submits in the portal → lands in the Sheet → you get a phone push + Mac alert → open the Desk → add a comment, tap **Send to Claude** → the worker fires Claude, which stages a draft → you **Approve** → it schedules via Postiz / applies the change. **Nothing goes live without your approval.**

## Security
- The `?k=` admin link is full control — keep it private.
- Per-client `?c=` tokens are secret links; add a `pin` per client in the Clients sheet for a second factor.
- `worker/config.json` holds secrets and is gitignored.

## Separate from lead-responder
This is its own Sheet, its own Apps Script deployment, its own launchd job (`com.nynm.client-worker`). It shares no state with the lead pipeline and cannot affect it.
