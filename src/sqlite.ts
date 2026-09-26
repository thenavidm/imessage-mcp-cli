/**
 * bun:sqlite's `query().all()` / `.get()`, on Node's built-in `node:sqlite`.
 *
 * The server was written for Bun. This keeps every query in the codebase
 * exactly as it was, and reproduces Bun's one behaviour that matters here:
 * Messages stores dates as nanoseconds since 2001, beyond JavaScript's safe
 * integers. `node:sqlite` refuses such a value unless it reads BigInts, while
 * Bun returns the nearest number, so this reads BigInts and converts them the
 * same way Bun does.
 */

import { createRequire } from "node:module";
import type { StatementSync } from "node:sqlite";

// Loaded at run time rather than imported, so tools that resolve imports
// ahead of Node (the test runner's) do not trip over a builtin they predate.
// Node marks the module experimental and warns on load. The warning lands on
// stderr of every CLI command, so this one is dropped and every other passes.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  if (String(warning).includes("SQLite is an experimental feature")) return;
  return (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

type Params = (string | number | bigint | null | Uint8Array)[];

function numbers<T>(row: unknown): T {
  if (!row || typeof row !== "object") return row as T;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    out[key] = typeof value === "bigint" ? Number(value) : value;
  }
  return out as T;
}

export class Query<T, P extends unknown[] = unknown[]> {
  constructor(private readonly statement: StatementSync) {
    statement.setReadBigInts(true);
  }

  all(...params: P): T[] {
    return (this.statement.all(...(params as unknown as Params)) as unknown[]).map((row) => numbers<T>(row));
  }

  get(...params: P): T | null {
    const row = this.statement.get(...(params as unknown as Params));
    return row === undefined ? null : numbers<T>(row);
  }
}

export class Database {
  private readonly db: InstanceType<typeof DatabaseSync>;

  constructor(path: string, options: { readonly?: boolean } = {}) {
    this.db = new DatabaseSync(path, { readOnly: options.readonly ?? false });
  }

  query<T = Record<string, unknown>, P extends unknown[] = unknown[]>(sql: string): Query<T, P> {
    return new Query<T, P>(this.db.prepare(sql));
  }

  close(): void {
    this.db.close();
  }
}
