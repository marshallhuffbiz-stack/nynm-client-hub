import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

// A tiny JSON-file store with serialized read-modify-write, mimicking the
// Apps Script Sheet + LockService. Single-process (the mock server), so an
// in-process promise queue is enough to serialize mutations.
export function createStore(path) {
  let queue = Promise.resolve();

  const empty = () => ({ settings: {}, clients: [], requests: [], events: [], vendors: [], bookings: [] });

  async function read() {
    if (!existsSync(path)) return empty();
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch {
      return empty();
    }
  }

  async function write(data) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(data, null, 2));
  }

  // Serialize: read fresh, let fn mutate in place + return a result, persist.
  function tx(fn) {
    queue = queue.then(async () => {
      const data = await read();
      const result = await fn(data);
      await write(data);
      return result;
    });
    return queue;
  }

  return { read, write, tx };
}
