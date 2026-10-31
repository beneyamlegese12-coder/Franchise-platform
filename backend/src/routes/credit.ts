import { Router } from "express";
import { z } from "zod";
import { pool, withTx } from "../db/pool.js";
import { auth } from "../auth.js";
import { post } from "../services/ledger.js";
import { HttpError } from "../errors.js";

export const credit = Router();

// Super agent sees requests sent to them; a club agent sees the ones they sent.
credit.get("/credit-requests", auth(["super", "club"]), async (req, res) => {
  const col = req.user!.role === "super" ? "approver_id" : "requester_id";
  const r = await pool.query(
    "SELECT q.id, q.amount_minor, q.status, q.note, q.created_at, u.display_name AS requester " +
    "FROM credit_requests q JOIN users u ON u.id=q.requester_id " +
    "WHERE q." + col + "=$1 ORDER BY q.id DESC LIMIT 100",
    [req.user!.id]
  );
  res.json(r.rows);
});

credit.post("/credit-requests", auth(["club"]), async (req, res) => {
  const p = z.object({
    amount_minor: z.number().int().positive().max(1_000_000_000),
    note: z.string().max(200).optional(),
  }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "amount_minor must be a positive whole number" }); return; }
  const me = await pool.query("SELECT parent_id FROM users WHERE id=$1", [req.user!.id]);
  const r = await pool.query(
    "INSERT INTO credit_requests (requester_id, approver_id, amount_minor, note) VALUES ($1,$2,$3,$4) RETURNING id",
    [req.user!.id, me.rows[0].parent_id, p.data.amount_minor, p.data.note ?? null]
  );
  res.status(201).json({ id: r.rows[0].id });
});

credit.post("/credit-requests/:id/approve", auth(["super"]), async (req, res) => {
  const out = await withTx(async (c) => {
    const q = await c.query(
      "SELECT * FROM credit_requests WHERE id=$1 AND approver_id=$2 FOR UPDATE",
      [Number(req.params.id), req.user!.id]
    );
    if (!q.rowCount) throw new HttpError(404, "Request not found");
    const r = q.rows[0];
    if (r.status !== "pending") throw new HttpError(409, "Request is already " + r.status);

    const acct = async (uid: number) =>
      (await c.query("SELECT id FROM accounts WHERE user_id=$1 AND type='credit'", [uid])).rows[0].id as number;

    await post(c, {
      kind: "transfer", key: "credit-request:" + r.id, memo: "Credit request #" + r.id, createdBy: req.user!.id,
      entries: [
        { accountId: await acct(r.approver_id), amount: -r.amount_minor },
        { accountId: await acct(r.requester_id), amount: r.amount_minor },
      ],
    });
    await c.query("UPDATE credit_requests SET status='approved', decided_at=now() WHERE id=$1", [r.id]);
    await c.query(
      "INSERT INTO audit_logs (actor_id, action, entity, entity_id, detail) VALUES ($1,'approve_credit','credit_request',$2,$3)",
      [req.user!.id, r.id, JSON.stringify({ amount_minor: r.amount_minor })]
    );
    return { id: r.id, amount_minor: r.amount_minor };
  });
  res.json(out);
});

credit.post("/credit-requests/:id/reject", auth(["super"]), async (req, res) => {
  const r = await pool.query(
    "UPDATE credit_requests SET status='rejected', decided_at=now() WHERE id=$1 AND approver_id=$2 AND status='pending' RETURNING id",
    [Number(req.params.id), req.user!.id]
  );
  if (!r.rowCount) { res.status(404).json({ error: "No pending request with that id" }); return; }
  await pool.query(
    "INSERT INTO audit_logs (actor_id, action, entity, entity_id) VALUES ($1,'reject_credit','credit_request',$2)",
    [req.user!.id, r.rows[0].id]
  );
  res.json({ id: r.rows[0].id, status: "rejected" });
});