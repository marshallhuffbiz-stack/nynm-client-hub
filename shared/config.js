// Client Hub — front-end config. THE ONE-LINE PRODUCTION SWAP LIVES HERE.
//
// mock : talk to the local Node mock backend (mock-server/server.mjs).
// live : talk to your deployed Apps Script web app.
//
// To go live: set API_MODE = "live" and paste your exec URL below (SETUP.md §3).
export const API_MODE = "mock"; // "mock" | "live"

export const API_BASE =
  API_MODE === "live"
    ? "https://script.google.com/macros/s/REPLACE_DEPLOYMENT_ID/exec"
    : "http://localhost:8787";
