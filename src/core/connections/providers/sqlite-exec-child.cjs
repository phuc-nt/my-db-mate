/**
 * SQLite execution child process (red-team C3). better-sqlite3 12.x is synchronous,
 * has no interrupt(), and blocks whatever thread runs it. A worker thread cannot be
 * killed mid-native-call, but a forked child process CAN: SIGKILL forcibly stops a
 * runaway query (e.g. a full scan over a 10M-row table) even while it is inside the
 * synchronous native call. So the provider forks this child per query and enforces
 * a hard kill-timeout from the parent.
 *
 * Plain .cjs so it loads with no transpile under tsx scripts and Next dev/prod;
 * better-sqlite3 is a serverExternalPackages native module resolved the same way as
 * in the main provider. The child opens its OWN readonly handle (same OS-level write
 * refusal) and runs exactly one already-safety-validated SELECT, then exits.
 */
const Database = require('better-sqlite3');

process.on('message', (msg) => {
  try {
    const db = new Database(msg.path, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 5000');
    const stmt = db.prepare(msg.sql);
    const columns = stmt.columns().map((c) => c.name);
    const rows = stmt.raw().all();
    db.close();
    process.send({ ok: true, columns, rows });
    process.exit(0);
  } catch (err) {
    process.send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    process.exit(0);
  }
});
