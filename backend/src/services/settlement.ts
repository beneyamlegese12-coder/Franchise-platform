import { withTx } from "../db/pool.js";
import { post } from "./ledger.js";

// Moves every agent's accrued commission into their credit balance.
// Returns null when an automatic run has already happened today.
export async function runSettlement(trigger: "auto" | "manual", actorId: number | null) {
  return withTx(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(7001)");
    const run = await c.query(
      "INSERT INTO settlement_runs (run_date, trigger, created_by) VALUES (CURRENT_DATE, $1, $2) " +
      "ON CONFLICT (run_date) WHERE trigger = 'auto' DO NOTHING RETURNING id",
      [trigger, actorId]
    );
    if (!run.rowCount) return null;
    const runId = run.rows[0].id as number;

    const recs = await c.query(
      "SELECT id, beneficiary_user_id AS uid, amount_minor FROM commission_records " +
      "WHERE status='accrued' AND amount_minor > 0 ORDER BY id FOR UPDATE"
    );
    const totals = new Map<number, number>();
    for (const r of recs.rows) totals.set(r.uid, (totals.get(r.uid) ?? 0) + r.amount_minor);

    let grand = 0;
    for (const [uid, total] of totals) {
      const a = await c.query("SELECT id, type FROM accounts WHERE user_id=$1 AND type IN ('commission','credit')", [uid]);
      const com = a.rows.find((x) => x.type === "commission")?.id;
      const cr = a.rows.find((x) => x.type === "credit")?.id;
      if (!com || !cr) throw new Error("User " + uid + " is missing a commission or credit account");
      const t = await post(c, {
        kind: "settlement", key: "settle:" + runId + ":" + uid, memo: "Daily settlement #" + runId, createdBy: actorId,
        entries: [{ accountId: com, amount: -total }, { accountId: cr, amount: total }],
      });
      await c.query("INSERT INTO settlements (run_id, user_id, total_minor, ledger_transaction_id) VALUES ($1,$2,$3,$4)", [runId, uid, total, t.id]);
      grand += total;
    }

    const ids = recs.rows.map((r) => r.id);
    if (ids.length) {
      await c.query("UPDATE commission_records SET status='settled', settlement_run_id=$1 WHERE id = ANY($2::bigint[])", [runId, ids]);
    }
    await c.query("UPDATE settlement_runs SET total_minor=$2, users_count=$3 WHERE id=$1", [runId, grand, totals.size]);
    await c.query(
      "INSERT INTO audit_logs (actor_id, action, entity, entity_id, detail) VALUES ($1,'run_settlement','settlement_run',$2,$3)",
      [actorId, runId, JSON.stringify({ trigger, total_minor: grand, users: totals.size })]
    );
    return { runId, total_minor: grand, users: totals.size };
  });
}