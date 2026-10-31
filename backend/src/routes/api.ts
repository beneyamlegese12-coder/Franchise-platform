import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { auth } from "../auth.js";
import { approveDeposit } from "../services/deposits.js";

export const api = Router();

const loginLimiter = rateLimit({ windowMs: 60_000, limit: 10 });

api.post("/auth/login", loginLimiter, async (req, res) => {
  const p = z.object({ username: z.string().min(1), password: z.string().min(1) }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "Username and password are required" }); return; }
  const r = await pool.query(
    "SELECT id, role, username, display_name, password_hash, status FROM users WHERE username=$1",
    [p.data.username]
  );
  const u = r.rows[0];
  if (!u || !(await bcrypt.compare(p.data.password, u.password_hash))) {
    res.status(401).json({ error: "Wrong username or password" });
    return;
  }
  if (u.status !== "active") { res.status(403).json({ error: "Account is " + u.status }); return; }
  const token = jwt.sign({ id: u.id, role: u.role, username: u.username }, process.env.JWT_SECRET as string, { expiresIn: "8h" });
  res.json({ token, user: { id: u.id, role: u.role, username: u.username, name: u.display_name } });
});

api.get("/overview", auth(["super"]), async (req, res) => {
  const id = req.user!.id;
  const one = async (sql: string) => (await pool.query(sql, [id])).rows[0].v as number;
  const commission = (type: string) =>
    "SELECT COALESCE(SUM(amount_minor),0)::bigint AS v FROM commission_records WHERE beneficiary_user_id=$1 AND level='super' AND event_type='" + type + "' AND status<>'reversed'";
  const credit = await one("SELECT balance_minor AS v FROM accounts WHERE user_id=$1 AND type='credit'");
  const dep = await one(commission("deposit"));
  const wd = await one(commission("withdrawal"));
  const turnover = await one(
    "SELECT COALESCE(SUM(b.amount_minor),0)::bigint AS v FROM bets b JOIN users p ON p.id=b.player_id JOIN users c ON c.id=p.parent_id WHERE c.parent_id=$1 AND b.status='settled'"
  );
  const clubs = await one("SELECT COUNT(*)::bigint AS v FROM users WHERE parent_id=$1 AND role='club'");
  const players = await one(
    "SELECT COUNT(*)::bigint AS v FROM users p JOIN users c ON c.id=p.parent_id WHERE c.parent_id=$1 AND p.role='player' AND p.status='active'"
  );
  res.json({
    credit_balance_minor: credit,
    deposit_overrides_minor: dep,
    withdraw_overrides_minor: wd,
    override_commissions_minor: dep + wd,
    network_turnover_minor: turnover,
    club_agents: clubs,
    active_players: players,
  });
});

api.get("/agents", auth(["super"]), async (req, res) => {
  const r = await pool.query(
    "SELECT u.id, u.username, u.display_name AS name, u.status, " +
    "(SELECT rate_bps FROM commission_rates r WHERE r.user_id=u.id AND r.event_type='deposit') AS deposit_rate_bps, " +
    "(SELECT COUNT(*) FROM users p WHERE p.parent_id=u.id AND p.role='player')::bigint AS players, " +
    "(SELECT balance_minor FROM accounts a WHERE a.user_id=u.id AND a.type='credit') AS credit_balance_minor " +
    "FROM users u WHERE u.parent_id=$1 AND u.role='club' ORDER BY u.id",
    [req.user!.id]
  );
  res.json(r.rows);
});

api.get("/ledger", auth(), async (req, res) => {
  const r = await pool.query(
    "SELECT t.id, t.kind, t.memo, t.created_at, a.type AS account_type, e.amount_minor, e.balance_after_minor " +
    "FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id JOIN accounts a ON a.id=e.account_id " +
    "WHERE a.user_id=$1 ORDER BY e.id DESC LIMIT 100",
    [req.user!.id]
  );
  res.json(r.rows);
});

api.get("/point-requests", auth(), async (req, res) => {
  const { id, role } = req.user!;
  const where =
    role === "player" ? "pr.player_id=$1"
    : role === "club" ? "pr.club_id=$1"
    : role === "super" ? "c.parent_id=$1"
    : "$1::bigint IS NOT NULL";
  const r = await pool.query(
    "SELECT pr.id, pr.type, pr.amount_minor, pr.status, pr.created_at, p.display_name AS player, c.display_name AS club " +
    "FROM point_requests pr JOIN users p ON p.id=pr.player_id JOIN users c ON c.id=pr.club_id " +
    "WHERE " + where + " ORDER BY pr.id DESC LIMIT 100",
    [id]
  );
  res.json(r.rows);
});

api.post("/point-requests", auth(["player"]), async (req, res) => {
  const p = z.object({ amount_minor: z.number().int().positive().max(100_000_000) }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "amount_minor must be a positive whole number" }); return; }
  const me = await pool.query("SELECT parent_id FROM users WHERE id=$1", [req.user!.id]);
  const r = await pool.query(
    "INSERT INTO point_requests (player_id, club_id, type, amount_minor) VALUES ($1,$2,'deposit',$3) RETURNING id",
    [req.user!.id, me.rows[0].parent_id, p.data.amount_minor]
  );
  res.status(201).json({ id: r.rows[0].id });
});

api.post("/point-requests/:id/approve", auth(["club", "admin"]), async (req, res) => {
  const out = await approveDeposit(Number(req.params.id), req.user!.id, req.user!.role);
  res.json(out);
});