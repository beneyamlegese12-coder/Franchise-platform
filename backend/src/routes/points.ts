import { Router } from "express";
import { z } from "zod";
import { pool, withTx } from "../db/pool.js";
import { auth } from "../auth.js";
import { post } from "../services/ledger.js";
import { HttpError } from "../errors.js";

export const points = Router();

const CHANNELS = ["CBE", "Telebirr", "Bank"] as const;
const PHONE = /^\+?[0-9 ]{7,16}$/;
const claimMinutes = () => Number(process.env.CLAIM_MINUTES) || 30;
const MAX_CLAIMS = 5;
const MAX_OPEN = 3;
const LABEL: Record<string, string> = { approved: "COMPLETED", rejected: "REJECTED", cancelled: "CANCELLED" };
// Club agents ask super agents, super agents ask admins
const claimerRole = (requesterRole: string) => (requesterRole === "club" ? "super" : "admin");

const audit = (actor: number, action: string, id: number, detail?: unknown) =>
  pool.query(
    "INSERT INTO audit_logs (actor_id, action, entity, entity_id, detail) VALUES ($1,$2,'point_ask',$3,$4)",
    [actor, action, id, detail ? JSON.stringify(detail) : null]
  );

async function channelsFor(ids: number[]) {
  const map = new Map<number, { channel: string; phone: string; account_no: string | null }[]>();
  if (!ids.length) return map;
  const r = await pool.query("SELECT user_id, channel, phone, account_no FROM agent_channels WHERE user_id = ANY($1::bigint[]) ORDER BY channel", [ids]);
  for (const x of r.rows) {
    const k = Number(x.user_id);
    map.set(k, [...(map.get(k) ?? []), { channel: x.channel, phone: x.phone, account_no: x.account_no }]);
  }
  return map;
}

// ---- Payment accounts for club agents, super agents and admins ----
const anyStaff = auth(["club", "super", "admin"]);

points.get("/my/channels", anyStaff, async (req, res) => {
  res.json((await pool.query("SELECT channel, phone, account_no FROM agent_channels WHERE user_id=$1 ORDER BY channel", [req.user!.id])).rows);
});

points.put("/my/channels", anyStaff, async (req, res) => {
  const p = z.object({
    channel: z.enum(CHANNELS),
    phone: z.string().trim().regex(PHONE, "Enter a valid phone number"),
    account_no: z.string().trim().max(40).optional(),
  }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: p.error.issues[0].message }); return; }
  if (p.data.channel !== "Telebirr" && (p.data.account_no ?? "").length < 6) throw new HttpError(400, "Enter the " + p.data.channel + " account number");
  await pool.query(
    "INSERT INTO agent_channels (user_id, channel, phone, account_no) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id, channel) DO UPDATE SET phone=EXCLUDED.phone, account_no=EXCLUDED.account_no",
    [req.user!.id, p.data.channel, p.data.phone, p.data.account_no || null]
  );
  res.json({ ok: true });
});

// ---- Requester side (club agent to super agent, super agent to admin) ----
points.post("/points/asks", auth(["club", "super"]), async (req, res) => {
  const p = z.object({
    type: z.enum(["deposit", "withdrawal"]),
    amount_minor: z.number().int().min(100, "The minimum is $1.00").max(1_000_000_000),
    note: z.string().trim().max(200).optional(),
  }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: p.error.issues[0].message }); return; }
  const me = req.user!;
  const open = (await pool.query("SELECT COUNT(*)::int AS v FROM point_asks WHERE requester_id=$1 AND status='pending'", [me.id])).rows[0].v as number;
  if (open >= MAX_OPEN) throw new HttpError(409, "You already have " + MAX_OPEN + " open requests. Wait for them to finish or cancel one.");
  if (p.data.type === "withdrawal") {
    const bal = (await pool.query("SELECT balance_minor AS v FROM accounts WHERE user_id=$1 AND type='credit'", [me.id])).rows[0]?.v ?? 0;
    if (bal < p.data.amount_minor) throw new HttpError(409, "You do not have that many points to withdraw");
    if (!(await channelsFor([me.id])).get(me.id)?.length) throw new HttpError(400, "Add your payment accounts first (Payment Accounts tab) so you can be paid");
  }
  const r = await pool.query(
    "INSERT INTO point_asks (requester_id, requester_role, type, amount_minor, note) VALUES ($1,$2,$3,$4,$5) RETURNING id",
    [me.id, me.role, p.data.type, p.data.amount_minor, p.data.note || null]
  );
  res.status(201).json({ id: r.rows[0].id });
});

points.get("/points/asks/mine", auth(["club", "super"]), async (req, res) => {
  const rows = (await pool.query(
    "SELECT a.id, a.type, a.amount_minor, a.reference, a.note, a.status, a.created_at, a.claimed_by, (a.claim_expires_at > now()) AS live, u.display_name AS claimer " +
    "FROM point_asks a LEFT JOIN users u ON u.id=a.claimed_by WHERE a.requester_id=$1 ORDER BY a.id DESC LIMIT 30",
    [req.user!.id]
  )).rows;
  const ch = await channelsFor(rows.filter((r) => r.claimed_by).map((r) => Number(r.claimed_by)));
  res.json(rows.map((r) => {
    const show = r.claimed_by && (r.status !== "pending" || r.live);
    return {
      id: r.id, type: r.type, amount_minor: r.amount_minor, reference: r.reference, note: r.note, created_at: r.created_at,
      status: r.status === "pending" ? (r.live && r.claimed_by ? "CLAIMED" : "OPEN") : (LABEL[r.status] ?? String(r.status).toUpperCase()),
      can_cancel: r.status === "pending" && !(r.live && r.claimed_by),
      claimer: show ? { name: r.claimer, channels: ch.get(Number(r.claimed_by)) ?? [] } : null,
    };
  }));
});

points.post("/points/asks/:id/reference", auth(["club", "super"]), async (req, res) => {
  const p = z.object({ reference: z.string().trim().min(4, "Enter the transaction reference").max(60) }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: p.error.issues[0].message }); return; }
  try {
    const r = await pool.query(
      "UPDATE point_asks SET reference=$3 WHERE id=$1 AND requester_id=$2 AND type='deposit' AND status='pending' AND claimed_by IS NOT NULL AND claim_expires_at > now() RETURNING id",
      [Number(req.params.id), req.user!.id, p.data.reference]
    );
    if (!r.rowCount) throw new HttpError(409, "You can add a reference once someone has claimed your request");
    res.json({ ok: true });
  } catch (e: any) {
    if (e?.code === "23505") throw new HttpError(409, "That reference has already been used");
    throw e;
  }
});

points.post("/points/asks/:id/cancel", auth(["club", "super"]), async (req, res) => {
  const r = await pool.query(
    "UPDATE point_asks SET status='cancelled', decided_at=now() WHERE id=$1 AND requester_id=$2 AND status='pending' AND (claimed_by IS NULL OR claim_expires_at <= now()) RETURNING id",
    [Number(req.params.id), req.user!.id]
  );
  if (!r.rowCount) throw new HttpError(409, "This request cannot be cancelled now");
  await audit(req.user!.id, "cancel_point_ask", r.rows[0].id);
  res.json({ id: r.rows[0].id, status: "cancelled" });
});

// ---- Claimer side (super agents see club requests, admins see super agent requests) ----
const claimers = auth(["super", "admin"]);

points.get("/points/pool", claimers, async (req, res) => {
  const want = req.user!.role === "super" ? "club" : "super";
  const requests = (await pool.query(
    "SELECT a.id, a.type, a.amount_minor, a.note, a.created_at, u.display_name AS requester, u.id AS requester_id " +
    "FROM point_asks a JOIN users u ON u.id=a.requester_id " +
    "WHERE a.requester_role=$1 AND a.status='pending' AND (a.claimed_by IS NULL OR a.claim_expires_at <= now()) ORDER BY a.created_at LIMIT 100",
    [want]
  )).rows;
  const bal = (await pool.query("SELECT balance_minor AS v FROM accounts WHERE user_id=$1 AND type='credit'", [req.user!.id])).rows[0]?.v ?? 0;
  res.json({ my_balance_minor: bal, unlimited: req.user!.role === "admin", requests });
});

points.get("/points/claims", claimers, async (req, res) => {
  const rows = (await pool.query(
    "SELECT a.id, a.type, a.amount_minor, a.reference, a.note, a.claim_expires_at, u.display_name AS requester, u.id AS requester_id, " +
    "(SELECT balance_minor FROM accounts x WHERE x.user_id=u.id AND x.type='credit') AS requester_balance_minor " +
    "FROM point_asks a JOIN users u ON u.id=a.requester_id " +
    "WHERE a.status='pending' AND a.claimed_by=$1 AND a.claim_expires_at > now() ORDER BY a.claimed_at",
    [req.user!.id]
  )).rows;
  const ch = await channelsFor(rows.map((r) => Number(r.requester_id)));
  res.json(rows.map((r) => ({ ...r, channels: ch.get(Number(r.requester_id)) ?? [] })));
});

points.post("/points/asks/:id/claim", claimers, async (req, res) => {
  const me = req.user!;
  const out = await withTx(async (c) => {
    // The row lock means two people pressing Claim at the same moment are served one after the other
    const r = (await c.query("SELECT * FROM point_asks WHERE id=$1 FOR UPDATE", [Number(req.params.id)])).rows[0];
    if (!r) throw new HttpError(404, "Request not found");
    if (claimerRole(r.requester_role) !== me.role) throw new HttpError(403, "This request is not for your level");
    if (r.status !== "pending") throw new HttpError(409, "This request is already " + r.status);
    if (r.claimed_by && new Date(r.claim_expires_at) > new Date()) {
      throw new HttpError(409, Number(r.claimed_by) === me.id ? "You already claimed this request" : "Someone else already claimed this request");
    }
    const held = (await c.query("SELECT COUNT(*)::int AS v FROM point_asks WHERE status='pending' AND claimed_by=$1 AND claim_expires_at > now()", [me.id])).rows[0].v as number;
    if (held >= MAX_CLAIMS) throw new HttpError(409, "You are holding " + MAX_CLAIMS + " claims already. Finish or release one first.");
    if (r.type === "deposit") {
      if (me.role === "super") {
        const bal = (await c.query("SELECT balance_minor AS v FROM accounts WHERE user_id=$1 AND type='credit'", [me.id])).rows[0]?.v ?? 0;
        if (bal < r.amount_minor) throw new HttpError(409, "Your balance is too low to cover this top-up");
      }
      const ch = await c.query("SELECT 1 FROM agent_channels WHERE user_id=$1", [me.id]);
      if (!ch.rowCount) throw new HttpError(409, "Add your payment accounts first, so the requester knows where to send the money");
    }
    await c.query(
      "UPDATE point_asks SET claimed_by=$2, claimed_at=now(), claim_expires_at=now() + ($3 || ' minutes')::interval WHERE id=$1",
      [r.id, me.id, String(claimMinutes())]
    );
    await c.query("INSERT INTO audit_logs (actor_id, action, entity, entity_id, detail) VALUES ($1,'claim_point_ask','point_ask',$2,$3)", [me.id, r.id, JSON.stringify({ type: r.type, amount_minor: r.amount_minor })]);
    return { id: r.id, minutes: claimMinutes() };
  });
  res.json(out);
});

points.post("/points/asks/:id/release", claimers, async (req, res) => {
  const r = await pool.query(
    "UPDATE point_asks SET claimed_by=NULL, claimed_at=NULL, claim_expires_at=NULL WHERE id=$1 AND status='pending' AND claimed_by=$2 RETURNING id",
    [Number(req.params.id), req.user!.id]
  );
  if (!r.rowCount) throw new HttpError(404, "You are not holding that request");
  await audit(req.user!.id, "release_point_ask", r.rows[0].id);
  res.json({ id: r.rows[0].id });
});

points.post("/points/asks/:id/reject", claimers, async (req, res) => {
  const r = await pool.query(
    "UPDATE point_asks SET status='rejected', decided_at=now() WHERE id=$1 AND status='pending' AND claimed_by=$2 AND claim_expires_at > now() RETURNING id",
    [Number(req.params.id), req.user!.id]
  );
  if (!r.rowCount) throw new HttpError(409, "Claim this request first (or your claim has expired)");
  await audit(req.user!.id, "reject_point_ask", r.rows[0].id);
  res.json({ id: r.rows[0].id, status: "rejected" });
});

points.post("/points/asks/:id/approve", claimers, async (req, res) => {
  const me = req.user!;
  try {
    const out = await withTx(async (c) => {
      const r = (await c.query("SELECT * FROM point_asks WHERE id=$1 FOR UPDATE", [Number(req.params.id)])).rows[0];
      if (!r) throw new HttpError(404, "Request not found");
      if (r.status !== "pending") throw new HttpError(409, "This request is already " + r.status);
      if (Number(r.claimed_by) !== me.id) throw new HttpError(403, "Claim this request first");
      if (new Date(r.claim_expires_at) < new Date()) throw new HttpError(409, "Your claim has expired. Claim it again if it is still open.");
      if (r.type === "deposit" && !r.reference) throw new HttpError(409, "The requester has not sent a transaction reference yet");

      const acct = async (uid: number, type: string) => {
        const a = await c.query("SELECT id FROM accounts WHERE user_id=$1 AND type=$2", [uid, type]);
        if (!a.rowCount) throw new HttpError(500, "Missing " + type + " account");
        return a.rows[0].id as number;
      };
      // An admin's points come from, and go back to, the mint account. A super agent uses their own balance.
      const mine = await acct(me.id, me.role === "admin" ? "mint" : "credit");
      const theirs = await acct(r.requester_id, "credit");
      const amt: number = r.amount_minor;
      await post(c, {
        kind: r.type === "deposit" ? "points_topup" : "points_withdrawal",
        key: "points-ask:" + r.id, memo: (r.type === "deposit" ? "Points top-up" : "Points withdrawal") + " #" + r.id, createdBy: me.id,
        entries: r.type === "deposit"
          ? [{ accountId: mine, amount: -amt }, { accountId: theirs, amount: amt }]
          : [{ accountId: theirs, amount: -amt }, { accountId: mine, amount: amt }],
      });
      await c.query("UPDATE point_asks SET status='approved', decided_at=now() WHERE id=$1", [r.id]);
      await c.query("INSERT INTO audit_logs (actor_id, action, entity, entity_id, detail) VALUES ($1,'approve_point_ask','point_ask',$2,$3)", [me.id, r.id, JSON.stringify({ type: r.type, amount_minor: amt, requester_id: r.requester_id })]);
      return { id: r.id, type: r.type, amount_minor: amt };
    });
    res.json(out);
  } catch (e: any) {
    if (e?.code === "23514") throw new HttpError(409, "Not enough points on one side of this transfer");
    throw e;
  }
});