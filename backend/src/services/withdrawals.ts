import type { PoolClient } from "pg";
import { withTx } from "../db/pool.js";
import { post } from "./ledger.js";
import { splitDeposit } from "./commission.js";
import { HttpError } from "../errors.js";

const acct = async (c: PoolClient, uid: number, type: string) => {
  const r = await c.query("SELECT id FROM accounts WHERE user_id=$1 AND type=$2", [uid, type]);
  if (!r.rowCount) throw new HttpError(500, "Missing " + type + " account for user " + uid);
  return r.rows[0].id as number;
};

async function lockPending(c: PoolClient, id: number, actorId: number, role: string) {
  const q = await c.query("SELECT * FROM point_requests WHERE id=$1 FOR UPDATE", [id]);
  if (!q.rowCount) throw new HttpError(404, "Request not found");
  const r = q.rows[0];
  if (r.type !== "withdrawal") throw new HttpError(400, "This is not a withdrawal request");
  if (r.status !== "pending") throw new HttpError(409, "Request is already " + r.status);
  if (role !== "admin" && actorId !== r.club_id) throw new HttpError(403, "Only the player's club agent can decide this");
  return r;
}

// Player asks to cash out: credits move to a hold account straight away.
export async function requestWithdrawal(playerId: number, amount: number) {
  return withTx(async (c) => {
    const me = (await c.query("SELECT parent_id, status FROM users WHERE id=$1", [playerId])).rows[0];
    if (me.status !== "active") throw new HttpError(403, "Account is " + me.status);
    const rq = await c.query(
      "INSERT INTO point_requests (player_id, club_id, type, amount_minor) VALUES ($1,$2,'withdrawal',$3) RETURNING id",
      [playerId, me.parent_id, amount]
    );
    const id = rq.rows[0].id as number;
    await post(c, {
      kind: "withdrawal_hold", key: "wd-hold:" + id, memo: "Withdrawal request #" + id, createdBy: playerId,
      entries: [
        { accountId: await acct(c, playerId, "credit"), amount: -amount },
        { accountId: await acct(c, playerId, "hold"), amount },
      ],
    });
    return { id, amount_minor: amount, status: "pending" };
  });
}

// Club agent has paid the cash: credits go back to the club, commissions are posted.
export async function approveWithdrawal(requestId: number, actorId: number, role: string) {
  return withTx(async (c) => {
    const r = await lockPending(c, requestId, actorId, role);
    const amt: number = r.amount_minor;

    const club = (await c.query("SELECT id, parent_id FROM users WHERE id=$1", [r.club_id])).rows[0];
    const sup = (await c.query("SELECT id, parent_id FROM users WHERE id=$1", [club.parent_id])).rows[0];
    const adminId: number = sup.parent_id;

    await post(c, {
      kind: "withdrawal", key: "wd-final:" + r.id, memo: "Withdrawal request #" + r.id, createdBy: actorId,
      entries: [
        { accountId: await acct(c, r.player_id, "hold"), amount: -amt },
        { accountId: await acct(c, club.id, "credit"), amount: amt },
      ],
    });

    const rateRows = await c.query(
      "SELECT user_id, rate_bps FROM commission_rates WHERE event_type='withdrawal' AND user_id = ANY($1::bigint[])",
      [[club.id, sup.id, adminId]]
    );
    const rate = (uid: number) => rateRows.rows.find((x) => x.user_id === uid)?.rate_bps ?? 0;
    const s = splitDeposit(amt, rate(club.id), rate(sup.id), rate(adminId));
    const slices = [
      { level: "club", uid: club.id as number, amount: s.club, bps: rate(club.id) },
      { level: "super", uid: sup.id as number, amount: s.sup, bps: rate(sup.id) },
      { level: "admin", uid: adminId, amount: s.admin, bps: rate(adminId) },
    ];
    const paying = slices.filter((x) => x.amount > 0);
    if (paying.length) {
      const ct = await post(c, {
        kind: "commission", key: "commission:withdrawal:" + r.id, memo: "Commission for withdrawal #" + r.id, createdBy: actorId,
        entries: [
          { accountId: await acct(c, adminId, "pool"), amount: -paying.reduce((a, x) => a + x.amount, 0) },
          ...(await Promise.all(paying.map(async (x) => ({ accountId: await acct(c, x.uid, "commission"), amount: x.amount })))),
        ],
      });
      for (const x of slices) {
        await c.query(
          "INSERT INTO commission_records (source_transaction_id, point_request_id, beneficiary_user_id, level, event_type, base_amount_minor, rate_bps, amount_minor) VALUES ($1,$2,$3,$4,'withdrawal',$5,$6,$7)",
          [ct.id, r.id, x.uid, x.level, amt, x.bps, x.amount]
        );
      }
    }

    await c.query("UPDATE point_requests SET status='approved', decided_at=now(), decided_by=$2 WHERE id=$1", [r.id, actorId]);
    await c.query(
      "INSERT INTO audit_logs (actor_id, action, entity, entity_id, detail) VALUES ($1,'approve_withdrawal','point_request',$2,$3)",
      [actorId, r.id, JSON.stringify({ amount_minor: amt, split: s })]
    );
    return { requestId: r.id, amount_minor: amt, commission: s };
  });
}

// Club agent declines: the hold is released back to the player.
export async function rejectWithdrawal(requestId: number, actorId: number, role: string) {
  return withTx(async (c) => {
    const r = await lockPending(c, requestId, actorId, role);
    await post(c, {
      kind: "withdrawal_release", key: "wd-release:" + r.id, memo: "Withdrawal #" + r.id + " rejected", createdBy: actorId,
      entries: [
        { accountId: await acct(c, r.player_id, "hold"), amount: -r.amount_minor },
        { accountId: await acct(c, r.player_id, "credit"), amount: r.amount_minor },
      ],
    });
    await c.query("UPDATE point_requests SET status='rejected', decided_at=now(), decided_by=$2 WHERE id=$1", [r.id, actorId]);
    await c.query("INSERT INTO audit_logs (actor_id, action, entity, entity_id) VALUES ($1,'reject_withdrawal','point_request',$2)", [actorId, r.id]);
    return { id: r.id, status: "rejected" };
  });
}