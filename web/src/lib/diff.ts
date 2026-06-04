// Compact LCS line diff for the config commit preview. Files are small, so the
// O(n·m) table is fine. Produces aligned rows for a side-by-side view.

export interface DiffRow {
  type: "same" | "add" | "del";
  left: string | null;
  right: string | null;
  leftNo: number | null;
  rightNo: number | null;
}

export function diffLines(before: string, after: string): DiffRow[] {
  const a = before.length ? before.split("\n") : [];
  const b = after.length ? after.split("\n") : [];
  const n = a.length;
  const m = b.length;

  // lcs[i][j] = length of LCS of a[i:] and b[j:]
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: "same", left: a[i], right: b[j], leftNo: i + 1, rightNo: j + 1 });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      rows.push({ type: "del", left: a[i], right: null, leftNo: i + 1, rightNo: null });
      i++;
    } else {
      rows.push({ type: "add", left: null, right: b[j], leftNo: null, rightNo: j + 1 });
      j++;
    }
  }
  while (i < n) {
    rows.push({ type: "del", left: a[i], right: null, leftNo: i + 1, rightNo: null });
    i++;
  }
  while (j < m) {
    rows.push({ type: "add", left: null, right: b[j], leftNo: null, rightNo: j + 1 });
    j++;
  }
  return rows;
}

export function diffStats(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const r of rows) {
    if (r.type === "add") added++;
    else if (r.type === "del") removed++;
  }
  return { added, removed };
}
