export type Row = Record<string, unknown>;
export type Param = string | number | bigint | null | Uint8Array;

export type Db = {
  exec(sql: string): void;
  run(sql: string, ...params: Param[]): { changes: number };
  get<T = Row>(sql: string, ...params: Param[]): T | undefined;
  all<T = Row>(sql: string, ...params: Param[]): T[];
  close(): void;
};

/** The subset shared by `node:sqlite` DatabaseSync and `bun:sqlite` Database. */
type Stmt = {
  run(...p: Param[]): { changes: number | bigint };
  get(...p: Param[]): unknown;
  all(...p: Param[]): unknown[];
};
type Driver = { exec(sql: string): unknown; prepare(sql: string): Stmt; close(): void };
type DriverCtor = new (path: string, opts?: { create?: boolean }) => Driver;

export async function openDb(path: string): Promise<Db> {
  let db: Driver;
  if (process.versions.bun) {
    const spec = "bun:sqlite";
    const mod = (await import(spec)) as { Database: DriverCtor };
    db = new mod.Database(path, { create: true });
  } else {
    process.removeAllListeners("warning");
    process.on("warning", (w) => {
      if (w.name !== "ExperimentalWarning") process.stderr.write(String(w) + "\n");
    });
    const mod = await import("node:sqlite");
    // DatabaseSync matches Driver structurally except for its richer parameter types.
    db = new (mod.DatabaseSync as unknown as DriverCtor)(path);
  }
  const stmts = new Map<string, Stmt>();
  const prep = (sql: string): Stmt => {
    let s = stmts.get(sql);
    if (!s) stmts.set(sql, (s = db.prepare(sql)));
    return s;
  };
  const wrap: Db = {
    exec: (sql) => void db.exec(sql),
    run: (sql, ...p) => ({ changes: Number(prep(sql).run(...p).changes) }),
    get: <T>(sql: string, ...p: Param[]) => (prep(sql).get(...p) ?? undefined) as T | undefined,
    all: <T>(sql: string, ...p: Param[]) => prep(sql).all(...p) as T[],
    close: () => { stmts.clear(); db.close(); },
  };
  wrap.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000;");
  return wrap;
}
