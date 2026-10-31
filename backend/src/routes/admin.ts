import { Router } from "express";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { pool, withTx } from "../db/pool.js";
import { auth } from "../auth.js";
import { post } from "../services/ledger.js";
import { HttpError } from "../errors.js";

export const admin = Router();
const only = auth(["admin"]);

const sum = async (type: string) =>
  (await pool.query("SELECT COALESCE(SUM(balance_minor),0)::bigint AS v FROM accounts WHERE type=$1", [type])).rows[0].v as number;
const count = async (sql: string) => (await pool.query(sql)).rows[0].v as number;

admin.get("/admin/overview", only, async (_req, res) => {
  res.json({
    minted_minor: -(await sum("mint")),
    in_circulation_minor: await sum("credit"),
    held_minor: await sum("hold"),
    commission_paid_minor: -(await sum("pool")),
    super_agents: await count("SELECT COUNT(*)::bigint AS v FROM users WHERE role='super'"),
    club_agents: await count("SELECT COUNT(*)::bigint AS v FROM users WHERE role='club'"),
    players: await count("SELECT COUNT(*)::bigint AS v FROM users WHERE role='player'"),
    pending_requests: await count("SELECT COUNT(*)::bigint AS v FROM point_requests WHERE status='pending'"),
  });
});

admin.get("/admin/users", only, async (_req, res) => {
  const r = await pool.query(
    "SELECT u.id, u.role, u.username, u.display_name AS name, u.status, p.display_name AS parent, " +
    "(SELECT balance_minor FROM accounts a WHERE a.user_id=u.id AND a.type='credit') AS credit_balance_minor, " +
    "(SELECT balance_minor FROM accounts a WHERE a.user_id=u.id AND a.type='commission') AS commission_balance_minor " +
    "FROM users u LEFT JOIN users p ON p.id=u.parent_id WHERE u.role <> 'admin' ORDER BY u.id"
  );
  res.json(r.rows);
});

admin.post("/admin/users", only, async (req, res) => {
  const p = z.object({
    role: z.enum(["super", "club"]),
    parent_id: z.number().int().positive().optional(),
    username: z.string().regex(/^[a-z0-9_]{3,30}$/, "Username: 3-30 lowercase letters, numbers or underscores"),
    display_name: z.string().min(1).max(60),
    password: z.string().min(8).max(100),
    deposit_rate_bps: z.number().int().min(0).max(10000),
    withdrawal_rate_bps: z.number().int().min(0).max(10000),
  }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: p.error.issues[0].message }); return; }
  const d = p.data;
  try {
    const hash = await bcrypt.hash(d.password, 10);
    const id = await withTx(async (c) => {
      let parent = req.user!.id;
      if (d.role === "club") {
        if (!d.parent_id) throw new HttpError(400, "Choose the super agent this club belongs to");
        const s = await c.query("SELECT id FROM users WHERE id=$1 AND role='super'", [d.parent_id]);
        if (!s.rowCount) throw new HttpError(400, "That super agent does not exist");
        parent = d.parent_id;
      }
      const u = await c.query(
        "INSERT INTO users (role, parent_id, username, display_name, password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id",
        [d.role, parent, d.username, d.display_name, hash]
      );
      const uid = u.rows[0].id as number;
      await c.query("INSERT INTO accounts (user_id, type) VALUES ($1,'credit'), ($1,'commission')", [uid]);
      await c.query(
        "INSERT INTO commission_rates (user_id, event_type, rate_bps, cap_bps) VALUES ($1,'deposit',$2,$2), ($1,'withdrawal',$3,$3)",
        [uid, d.deposit_rate_bps, d.withdrawal_rate_bps]
      );
      await c.query(
        "INSERT INTO audit_logs (actor_id, action, entity, entity_id, detail) VALUES ($1,'create_user','user',$2,$3)",
        [req.user!.id, uid, JSON.stringify({ role: d.role, parent, deposit_rate_bps: d.deposit_rate_bps, withdrawal_rate_bps: d.withdrawal_rate_bps })]
      );
      return uid;
    });
    res.status(201).json({ id });
  } catch (e: any) {
    if (e?.code === "23505") { res.status(409).json({ error: "That username is already taken" }); return; }
    throw e;
  }
});

admin.post("/admin/users/:id/status", only, async (req, res) => {
  const p = z.object({ status: z.enum(["active", "frozen", "banned"]) }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "Status must be active, frozen or banned" }); return; }
  const r = await pool.query("UPDATE users SET status=$1 WHERE id=$2 AND role <> 'admin' RETURNING id", [p.data.status, Number(req.params.id)]);
  if (!r.rowCount) throw new HttpError(404, "User not found");
  await pool.query(
    "INSERT INTO audit_logs (actor_id, action, entity, entity_id, detail) VALUES ($1,'set_status','user',$2,$3)",
    [req.user!.id, r.rows[0].id, JSON.stringify({ status: p.data.status })]
  );
  res.json({ id: r.rows[0].id, status: p.data.status });
});

admin.post("/admin/mint", only, async (req, res) => {
  const p = z.object({
    user_id: z.number().int().positive(),
    amount_minor: z.number().int().positive().max(100_000_000_000),
    reason: z.string().min(3).max(200),
  }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: p.error.issues[0].message }); return; }
  const out = await withTx(async (c) => {
    const t = await c.query("SELECT id FROM users WHERE id=$1 AND role='super'", [p.data.user_id]);
    if (!t.rowCount) throw new HttpError(400, "Credits can only be minted to a super agent");
    const mint = (await c.query("SELECT id FROM accounts WHERE user_id=$1 AND type='mint'", [req.user!.id])).rows[0]?.id;
    const dest = (await c.query("SELECT id FROM accounts WHERE user_id=$1 AND type='credit'", [p.data.user_id])).rows[0]?.id;
    if (!mint || !dest) throw new HttpError(500, "Missing mint or credit account");
    const tx = await post(c, {
      kind: "mint", key: "mint:" + randomUUID(), memo: "Mint: " + p.data.reason, createdBy: req.user!.id,
      entries: [{ accountId: mint, amount: -p.data.amount_minor }, { accountId: dest, amount: p.data.amount_minor }],
    });
    await c.query(
      "INSERT INTO audit_logs (actor_id, action, entity, entity_id, detail) VALUES ($1,'mint_credits','user',$2,$3)",
      [req.user!.id, p.data.user_id, JSON.stringify({ amount_minor: p.data.amount_minor, reason: p.data.reason, transaction_id: tx.id })]
    );
    return { transaction_id: tx.id, amount_minor: p.data.amount_minor };
  });
  res.status(201).json(out);
});

admin.get("/admin/rates", only, async (_req, res) => {
  const r = await pool.query(
    "SELECT r.user_id, u.display_name AS name, u.role, r.event_type, r.rate_bps, r.cap_bps " +
    "FROM commission_rates r JOIN users u ON u.id=r.user_id ORDER BY u.id, r.event_type"
  );
  res.json(r.rows);
});

admin.put("/admin/rates", only, async (req, res) => {
  const p = z.object({
    user_id: z.number().int().positive(),
    event_type: z.enum(["deposit", "withdrawal"]),
    rate_bps: z.number().int().min(0).max(10000),
    cap_bps: z.number().int().min(0).max(10000),
  }).refine((v) => v.rate_bps <= v.cap_bps, { message: "The rate cannot be higher than its cap" }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: p.error.issues[0].message }); return; }
  const d = p.data;
  await pool.query(
    "INSERT INTO commission_rates (user_id, event_type, rate_bps, cap_bps) VALUES ($1,$2,$3,$4) " +
    "ON CONFLICT (user_id, event_type) DO UPDATE SET rate_bps=EXCLUDED.rate_bps, cap_bps=EXCLUDED.cap_bps",
    [d.user_id, d.event_type, d.rate_bps, d.cap_bps]
  );
  await pool.query(
    "INSERT INTO audit_logs (actor_id, action, entity, entity_id, detail) VALUES ($1,'set_rate','user',$2,$3)",
    [req.user!.id, d.user_id, JSON.stringify(d)]
  );
  res.json(d);
});

admin.get("/admin/audit", only, async (_req, res) => {
  const r = await pool.query(
    "SELECT l.id, l.action, l.entity, l.entity_id, l.detail, l.created_at, u.display_name AS actor " +
    "FROM audit_logs l LEFT JOIN users u ON u.id=l.actor_id ORDER BY l.id DESC LIMIT 100"
  );
  res.json(r.rows);
});

// Proves the books balance: every transaction nets to zero and each cached balance equals its ledger entries.
admin.get("/admin/reconcile", only, async (_req, res) => {
  const total = await count("SELECT COALESCE(SUM(amount_minor),0)::bigint AS v FROM ledger_entries");
  const unbalanced = await count(
    "SELECT COUNT(*)::bigint AS v FROM (SELECT transaction_id FROM ledger_entries GROUP BY transaction_id HAVING SUM(amount_minor) <> 0) x"
  );
  const bad = await pool.query(
    "SELECT a.id, u.username, a.type, a.balance_minor, COALESCE(SUM(e.amount_minor),0)::bigint AS ledger_minor " +
    "FROM accounts a JOIN users u ON u.id=a.user_id LEFT JOIN ledger_entries e ON e.account_id=a.id " +
    "GROUP BY a.id, u.username HAVING a.balance_minor <> COALESCE(SUM(e.amount_minor),0)"
  );
  const entries = await count("SELECT COUNT(*)::bigint AS v FROM ledger_entries");
  res.json({
    ok: total === 0 && unbalanced === 0 && bad.rowCount === 0,
    entries_checked: entries,
    ledger_total_minor: total,
    unbalanced_transactions: unbalanced,
    mismatched_accounts: bad.rows,
    checked_at: new Date().toISOString(),
  });
});