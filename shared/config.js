// Client Hub — front-end config.
//
// The API base is picked automatically:
//   - Served from localhost/127.0.0.1 (npm run dev)  → the local Node mock backend.
//   - Served from anywhere else (GH Pages, prod)     → the deployed Apps Script web app.
//
// LIVE_EXEC_URL is the one line to update on a new Apps Script deployment (SETUP.md §3).

const LIVE_EXEC_URL =
  "https://script.google.com/macros/s/AKfycbyYSFFw_RxzPScj8PIeR6XDDlOhZivlHx-Ea7H7YygsONonUGxx1OOvvtP5uPS6Dj3X/exec";

const IS_LOCAL =
  typeof location !== "undefined" &&
  (location.hostname === "localhost" || location.hostname === "127.0.0.1");

// Local mock API port; override via ?api=<port> for a non-default dev setup.
const LOCAL_API_PORT =
  (typeof location !== "undefined" &&
    new URLSearchParams(location.search).get("api")) ||
  "8787";

export const API_MODE = IS_LOCAL ? "mock" : "live"; // "mock" | "live"

export const API_BASE = IS_LOCAL
  ? `http://${location.hostname}:${LOCAL_API_PORT}`
  : LIVE_EXEC_URL;
