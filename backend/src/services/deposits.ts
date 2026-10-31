import { withTx } from "../db/pool.js";
import { post } from "./ledger.js";
import { splitDeposit } from "./commission.js";
import { HttpError } from "../errors.js";

export async function approveDeposit(requestId: number, actorId: number, actorRole: string) {
  return withTx(async (c) => {
    const rq = await c.query("SELECT * FROM point_requests WHERE id=$1 FOR UPDATE", [requestId]);
    if (!rq.rowCount) throw new HttpError(404, "Request not found");
    const r = rq.rows[0];
    if (r.status !== "pending") throw new HttpError(409, "Request is already " + r.status);
    if (r.type !== "deposit") throw new HttpError(400, "Only deposit requests are supported so far");
    if (actorRole !== "admin" && actorId !== r.club_id) {
      throw new HttpError(403, "Only the player's club agent can approve this");
    }

    const club = (await c.query("SELECT id, parent_id FROM users WHERE id=$1", [r.club_id])).rows[0];
    const sup = (await c.query("SELECT id, parent_id FROM users WHERE id=$1", [club.parent_id])).rows[0];
    const adminId: number = sup.parent_id;

    const rateRows = await c.query(
      "SELECT user_id, rate_bps FROM commission_rates WHERE event_type='deposit' AND user_id = ANY($1::bigint[])",
      [[club.id, sup.id, adminId]]
    );
    const rate = (uid: number) => rateRows.rows.find((x) => x.user_id === uid)?.rate_bps ?? 0;

    const acct = async (uid: number, type: string) =>
      (await c.query("SELECT id FROM accounts WHERE user_id=$1 AND type=$2", [uid, type])).rows[0].id as number;

    const amt: number = r.amount_minor;

    // 1) Move credits from the club agent to the player
    const t = await post(c, {
      kind: "deposit", key: "deposit:" + r.id, memo: "Deposit request #" + r.id, createdBy: actorId,
      entries: [
        { accountId: await acct(club.id, "credit"), amount: -amt },
        { accountId: await acct(r.player_id, "credit"), amount: amt },
      ],
    });

    // 2) Split the commission: club, super (override), admin
    const s = splitDeposit(amt, rate(club.id), rate(sup.id), rate(adminId));
    const slices = [
      { level: "club", uid: club.id as number, amount: s.club, bps: rate(club.id) },
      { level: "super", uid: sup.id as number, amount: s.sup, bps: rate(sup.id) },
      { level: "admin", uid: adminId, amount: s.admin, bps: rate(adminId) },
    ];
    const paying = slices.filter((x) => x.amount > 0);
    if (paying.length) {
      const ct = await post(c, {
        kind: "commission", key: "commission:deposit:" + r.id, memo: "Commission for deposit #" + r.id, createdBy: actorId,
        entries: [
          { accountId: await acct(adminId, "pool"), amount: -paying.reduce((a, x) => a + x.amount, 0) },
          ...(await Promise.all(paying.map(async (x) => ({ accountId: await acct(x.uid, "commission"), amount: x.amount })))),
        ],
      });
      for (const x of slices) {
        await c.query(
          "INSERT INTO commission_records (source_transaction_id, point_request_id, beneficiary_user_id, level, event_type, base_amount_minor, rate_bps, amount_minor) VALUES ($1,$2,$3,$4,'deposit',$5,$6,$7)",
          [ct.id, r.id, x.uid, x.level, amt, x.bps, x.amount]
        );
      }
    }

    await c.query("UPDATE point_requests SET status='approved', decided_at=now(), decided_by=$2 WHERE id=$1", [r.id, actorId]);
    await c.query("INSERT INTO audit_logs (actor_id, action, entity, entity_id, detail) VALUES ($1,'approve_deposit','point_request',$2,$3)",
      [actorId, r.id, JSON.stringify({ amount_minor: amt, transaction_id: t.id, split: s })]);

    return { requestId: r.id, amount_minor: amt, commission: s };
  });
}