export type NewReport = { ownerId: string; title: string; body: string };
export type Report = NewReport & { id: number; createdAt: number };

/** In-memory store. Owner scoping lives here so the router cannot forget it. */
export class Store {
  private rows: Report[] = [];
  private nextId = 1;

  list(ownerId: string): Report[] {
    return this.rows.filter((r) => r.ownerId === ownerId);
  }

  insert(r: NewReport): Report {
    const row: Report = { ...r, id: this.nextId++, createdAt: Date.now() };
    this.rows.push(row);
    return row;
  }

  prune(olderThanMs: number, now: number): number {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => now - r.createdAt < olderThanMs);
    return before - this.rows.length;
  }
}
