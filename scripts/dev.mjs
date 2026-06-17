// Dev runner: mock API on :8787 + static file server on :8080 for the PWAs.
// Open the printed Portal / Desk URLs in a browser to use the system locally.
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import http from "node:http";
import { createApp } from "../mock-server/server.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const API_PORT = Number(process.env.API_PORT || 8787);
const WEB_PORT = Number(process.env.WEB_PORT || 8080);

createApp({ storePath: join(root, "data", "store.json") }).listen(API_PORT, "127.0.0.1", () =>
  console.log(`API  http://127.0.0.1:${API_PORT}`)
);

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

http
  .createServer(async (req, res) => {
    try {
      const u = new URL(req.url, "http://localhost");
      let p = decodeURIComponent(u.pathname);
      if (p.endsWith("/")) p += "index.html";
      let f = join(root, p);
      if (!f.startsWith(root)) {
        res.writeHead(403);
        return res.end("forbidden");
      }
      if (!existsSync(f) || statSync(f).isDirectory()) {
        const alt = join(f, "index.html");
        if (existsSync(alt)) f = alt;
        else {
          res.writeHead(404);
          return res.end("not found");
        }
      }
      const data = await readFile(f);
      res.writeHead(200, { "content-type": MIME[extname(f)] || "application/octet-stream" });
      res.end(data);
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  })
  .listen(WEB_PORT, "127.0.0.1", () => {
    console.log(`WEB  http://127.0.0.1:${WEB_PORT}`);
    console.log(`Portal (The O):  http://127.0.0.1:${WEB_PORT}/portal/?c=dev-the-o`);
    console.log(`Request Desk:    http://127.0.0.1:${WEB_PORT}/desk/?k=dev-admin`);
  });
