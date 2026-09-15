import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRouter } from "../src/router.js";
import { Store } from "../src/store.js";

describe("createRouter", () => {
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

  it("rejects GET /reports without an owner header", async () => {
    const res = await fetch(`${baseUrl}/reports`);
    expect(res.status).toBe(400);
  });

  it("creates a report and lists it back for its owner", async () => {
    const created = await fetch(`${baseUrl}/reports`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-owner-id": "a" },
      body: JSON.stringify({ title: "one", body: "x" }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.title).toBe("one");

    const listed = await fetch(`${baseUrl}/reports`, { headers: { "x-owner-id": "a" } });
    expect(listed.status).toBe(200);
    const rows = await listed.json();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(createdBody.id);
  });

  it("does not leak reports across owners", async () => {
    await fetch(`${baseUrl}/reports`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-owner-id": "a" },
      body: JSON.stringify({ title: "mine", body: "x" }),
    });

    const listed = await fetch(`${baseUrl}/reports`, { headers: { "x-owner-id": "b" } });
    expect(await listed.json()).toEqual([]);
  });

  it("rejects a POST with a blank title", async () => {
    const res = await fetch(`${baseUrl}/reports`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-owner-id": "a" },
      body: JSON.stringify({ title: "  ", body: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown routes", async () => {
    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(404);
  });

  it("rate limits an owner creating too many reports too quickly", async () => {
    let lastStatus = 0;
    for (let i = 0; i < 32; i += 1) {
      const res = await fetch(`${baseUrl}/reports`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-owner-id": "spammer" },
        body: JSON.stringify({ title: `r${i}`, body: "x" }),
      });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });
});
