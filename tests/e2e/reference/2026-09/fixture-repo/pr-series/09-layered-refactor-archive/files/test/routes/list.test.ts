import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRouter } from "../../src/router.js";
import { Store } from "../../src/store.js";

describe("GET /reports", () => {
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

  it("rejects a request without an owner header", async () => {
    const res = await fetch(`${baseUrl}/reports`);
    expect(res.status).toBe(400);
  });

  it("does not leak reports across owners", async () => {
    store.insert({ ownerId: "a", title: "mine", body: "x" });
    const res = await fetch(`${baseUrl}/reports`, { headers: { "x-owner-id": "b" } });
    expect(await res.json()).toEqual([]);
  });

  it("lists an owner's reports", async () => {
    store.insert({ ownerId: "a", title: "mine", body: "x" });
    const res = await fetch(`${baseUrl}/reports`, { headers: { "x-owner-id": "a" } });
    const rows = await res.json();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("mine");
  });
});
