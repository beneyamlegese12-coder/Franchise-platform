import type { PoolClient } from "pg";
import { withTx } from "../db/pool.js";
import { post } from "./ledger.js";
import { HttpError } from "../errors.js";

const acct = async (c: PoolClient, uid: number, type: string) => {
  const r = await c.query("SELECT id FROM accounts WHERE user_id=$1 AND type=$2", [uid, type]);
  if (!r.rowCount) throw new HttpError(500, "Missing " + type + " account for user " + uid);
  return r.rows[0].id as number;
};

// Undoes an approved deposit or withdrawal and claws back every commission paid on it.
export async function reverseRequest(requestId: number, adminId: number, reason: string) {
  try {
    return await withTx(async (c) => {
      const q = await c.query("SELECT * FROM point_requests WHERE id=$1 FOR UPDATE", [requestId]);
      if (!q.rowCount) throw new HttpError(404, "Request not found");
      const r = q.rows[0];
      if (r.status === "reversed") throw new HttpError(409, "Request is already reversed");
      if (r.status !== "approved") throw new HttpError(409, "Only approved requests can be reversed (this one is " + r.status + ")");
      const amt: number = r.amount_minor;

      const playerCredit = await acct(c, r.player_id, "credit");
      const clubCredit = await acct(c, r.club_id, "credit");
      await post(c, {
        kind: "reversal", key: "reverse:" + r.id, memo: "Reversal of " + r.type + " #" + r.id + ": " + reason, createdBy: adminId,
        entries: r.type === "deposit"
          ? [{ accountId: playerCredit, amount: -amt }, { accountId: clubCredit, amount: amt }]
          : [{ accountId: clubCredit, amount: -amt }, { accountId: playerCredit, amount: amt }],
      });

      const recs = await c.query(
        "SELECT id, beneficiary_user_id AS uid, amount_minor, status FROM commission_records " +
        "WHERE point_request_id=$1 AND status <> 'reversed' AND amount_minor > 0 ORDER BY id FOR UPDATE",
        [r.id]
      );
      if (recs.rowCount) {
        const adminUser = (await c.query("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1")).rows[0].id as number;
        const pool = await acct(c, adminUser, "pool");
        const entries: { accountId: number; amount: number }[] = [];
        let total = 0;
        for (const x of recs.rows) {
          // Unsettled commission sits in the commission account; settled commission was paid into credits.
          const from = await acct(c, x.uid, x.status === "accrued" ? "commission" : "credit");
          entries.push({ accountId: from, amount: -x.amount_minor });
          total += x.amount_minor;
        }
        entries.push({ accountId: pool, amount: total });
        await post(c, {
          kind: "commission_reversal", key: "reverse-commission:" + r.id, memo: "Commission clawback for " + r.type + " #" + r.id, createdBy: adminId,
          entries,
        });
        await c.query("UPDATE commission_records SET status='reversed' WHERE id = ANY($1::bigint[])", [recs.rows.map((x) => x.id)]);
      }

      await c.query("UPDATE point_requests SET status='reversed' WHERE id=$1", [r.id]);
      await c.query(
        "INSERT INTO audit_logs (actor_id, action, entity, entity_id, detail) VALUES ($1,'reverse_request','point_request',$2,$3)",
        [adminId, r.id, JSON.stringify({ type: r.type, amount_minor: amt, reason, commissions_reversed: recs.rowCount })]
      );
      return { id: r.id, type: r.type, amount_minor: amt, commissions_reversed: recs.rowCount };
    });
  } catch (e: any) {
    if (e?.code === "23514") {
      throw new HttpError(409, "Cannot reverse: the player or an agent no longer has enough balance, because the money has already been spent. Resolve that first.");
    }
    throw e;
  }
}