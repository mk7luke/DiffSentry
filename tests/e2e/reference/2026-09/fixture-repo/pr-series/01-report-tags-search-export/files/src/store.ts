export type NewReport = { ownerId: string; title: string; body: string; tags?: string[] };
export type Report = { ownerId: string; title: string; body: string; tags: string[]; id: number; createdAt: number };

/** In-memory store. Owner scoping lives here so the router cannot forget it. */
export class Store {
  private rows: Report[] = [];
  private nextId = 1;

  list(ownerId: string): Report[] {
    return this.rows.filter((r) => r.ownerId === ownerId);
  }

  getById(id: number): Report | undefined {
    return this.rows.find((r) => r.id === id);
  }

  insert(r: NewReport): Report {
    const row: Report = { ownerId: r.ownerId, title: r.title, body: r.body, tags: r.tags ?? [], id: this.nextId++, createdAt: Date.now() };
    this.rows.push(row);
    return row;
  }

  update(id: number, patch: Partial<Pick<Report, "title" | "body" | "tags">>): Report | undefined {
    const idx = this.rows.findIndex((r) => r.id === id);
    if (idx === -1) return undefined;
    const updated: Report = { ...this.rows[idx], ...patch };
    this.rows[idx] = updated;
    return updated;
  }

  prune(olderThanMs: number, now: number): number {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => now - r.createdAt < olderThanMs);
    return before - this.rows.length;
  }
}
