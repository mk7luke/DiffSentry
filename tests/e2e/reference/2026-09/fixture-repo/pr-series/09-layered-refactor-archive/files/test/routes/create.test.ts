import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRouter } from "../../src/router.js";
import { Store } from "../../src/store.js";

describe("POST /reports", () => {
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

  it("creates a report for the owner in the header", async () => {
    const res = await fetch(`${baseUrl}/reports`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-owner-id": "a" },
      body: JSON.stringify({ title: "one", body: "x" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.title).toBe("one");
    expect(body.ownerId).toBe("a");
  });

  it("rejects a blank title", async () => {
    const res = await fetch(`${baseUrl}/reports`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-owner-id": "a" },
      body: JSON.stringify({ title: "  ", body: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a body that is not valid JSON", async () => {
    const res = await fetch(`${baseUrl}/reports`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-owner-id": "a" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });
});
