import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRouter } from "../../src/router.js";
import { Store } from "../../src/store.js";

describe("route dispatch", () => {
  let store: Store;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    store = new Store();
    server = createServer(createRouter(store));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected server to bind a TCP port");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns 404 for an unknown path", async () => {
    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(404);
  });

  it("returns 405 for an unsupported method on a known path", async () => {
    const res = await fetch(`${baseUrl}/reports`, { method: "DELETE" });
    expect(res.status).toBe(405);
  });
});
