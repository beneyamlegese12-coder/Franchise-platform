import { Router } from "express";
import { pool } from "../db/pool.js";
import { auth } from "../auth.js";

export const superDash = Router();
const only = auth(["super"]);

superDash.get("/super/dashboard", only, async (req, res) => {
  const me = req.user!.id;
  const bal = (await pool.query("SELECT COALESCE(balance_minor,0)::bigint AS v FROM accounts WHERE user_id=$1 AND type='credit'", [me])).rows[0]?.v ?? 0;
  const rates = (await pool.query("SELECT event_type, rate_bps, cap_bps FROM commission_rates WHERE user_id=$1", [me])).rows;
  const rate = (ev: string, k: "rate_bps" | "cap_bps") => (rates.find((r) => r.event_type === ev)?.[k] ?? 0) as number;
  const comm = (await pool.query(
    "SELECT event_type, COALESCE(SUM(amount_minor),0)::bigint AS v FROM commission_records WHERE beneficiary_user_id=$1 AND status<>'reversed' GROUP BY event_type", [me]
  )).rows;
  const commOf = (ev: string) => (comm.find((r) => r.event_type === ev)?.v ?? 0) as number;
  const turnover = (await pool.query(
    "SELECT COALESCE(SUM(b.amount_minor),0)::bigint AS v FROM bets b JOIN users p ON p.id=b.player_id JOIN users c ON c.id=p.parent_id WHERE c.parent_id=$1 AND b.status='settled'", [me]
  )).rows[0].v as number;
  const players = (await pool.query(
    "SELECT COUNT(*)::bigint AS total, COUNT(*) FILTER (WHERE p.status='active')::bigint AS active FROM users p JOIN users c ON c.id=p.parent_id WHERE p.role='player' AND c.parent_id=$1", [me]
  )).rows[0];
  const clubs = (await pool.query(
    "SELECT u.id, u.display_name AS name, u.username, u.phone, u.status, COALESCE(a.balance_minor,0)::bigint AS balance_minor, " +
    "(SELECT rate_bps FROM commission_rates r WHERE r.user_id=u.id AND r.event_type='deposit') AS dep_bps, " +
    "(SELECT rate_bps FROM commission_rates r WHERE r.user_id=u.id AND r.event_type='withdrawal') AS wd_bps, " +
    "(SELECT account_no FROM agent_channels ch WHERE ch.user_id=u.id AND ch.channel='CBE') AS cbe_account " +
    "FROM users u LEFT JOIN accounts a ON a.user_id=u.id AND a.type='credit' WHERE u.role='club' AND u.parent_id=$1 ORDER BY u.display_name", [me]
  )).rows;
  const upstream = (await pool.query("SELECT display_name FROM users WHERE id=(SELECT parent_id FROM users WHERE id=$1)", [me])).rows[0]?.display_name ?? "Admin";
  const pendingRequests = (await pool.query(
    "SELECT COUNT(*)::bigint AS v FROM point_requests pr JOIN users c ON c.id=pr.club_id WHERE pr.status='pending' AND c.parent_id=$1", [me]
  )).rows[0].v as number;
  const pendingAsks = (await pool.query(
    "SELECT COUNT(*)::bigint AS v FROM point_asks WHERE status='pending' AND requester_role='club' AND (claimed_by IS NULL OR claim_expires_at <= now() OR claimed_by=$1)", [me]
  )).rows[0].v as number;
  res.json({
    balance_minor: bal, upstream,
    rates: { dep_bps: rate("deposit", "rate_bps"), wd_bps: rate("withdrawal", "rate_bps"), dep_cap_bps: rate("deposit", "cap_bps"), wd_cap_bps: rate("withdrawal", "cap_bps") },
    commission: { deposit_minor: commOf("deposit"), withdrawal_minor: commOf("withdrawal") },
    turnover_minor: turnover,
    counts: { clubs: clubs.length, clubs_active: clubs.filter((c) => c.status === "active").length, players: players.total, players_active: players.active },
    clubs, pending_requests: pendingRequests, pending_point_asks: pendingAsks,
  });
});

// Player cashier requests handled by this super agent's clubs
superDash.get("/super/downline-requests", only, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
  const rows = (await pool.query(
    "SELECT pr.id, pr.type, pr.amount_minor, pr.status, pr.channel, pr.player_phone, pr.player_account, pr.transfer_ref, pr.created_at, " +
    "(pr.claim_expires_at > now()) AS live, pr.claimed_by, p.display_name AS player, p.id AS player_id, c.display_name AS club " +
    "FROM point_requests pr JOIN users p ON p.id=pr.player_id JOIN users c ON c.id=pr.club_id " +
    "WHERE c.parent_id=$1 ORDER BY pr.created_at DESC LIMIT $2", [req.user!.id, limit]
  )).rows;
  res.json(rows.map((r) => ({
    id: r.id, type: r.type, amount_minor: r.amount_minor, channel: r.channel, created_at: r.created_at,
    player: r.player, player_id: r.player_id, club: r.club,
    status: r.status === "pending" ? (r.live && r.claimed_by ? "CLAIMED" : "PENDING") : String(r.status).toUpperCase(),
    reference: r.transfer_ref, phone: r.player_phone, account: r.player_account,
  })));
});

// Ledger transactions that touch this super agent's own accounts
superDash.get("/super/ledger", only, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  res.json((await pool.query(
    "SELECT t.id, t.kind, t.memo, t.created_at, " +
    "(SELECT COALESCE(MAX(e.amount_minor),0)::bigint FROM ledger_entries e WHERE e.transaction_id=t.id AND e.amount_minor>0) AS amount_minor, " +
    "(SELECT string_agg(DISTINCT u.display_name, ', ') FROM ledger_entries e JOIN accounts a ON a.id=e.account_id JOIN users u ON u.id=a.user_id WHERE e.transaction_id=t.id AND e.amount_minor<0) AS sender, " +
    "(SELECT string_agg(DISTINCT u.display_name, ', ') FROM ledger_entries e JOIN accounts a ON a.id=e.account_id JOIN users u ON u.id=a.user_id WHERE e.transaction_id=t.id AND e.amount_minor>0) AS receiver, " +
    "(SELECT COALESCE(SUM(c.amount_minor),0)::bigint FROM commission_records c WHERE c.source_transaction_id=t.id AND c.beneficiary_user_id=$1 AND c.status<>'reversed') AS my_commission_minor " +
    "FROM ledger_transactions t WHERE EXISTS (SELECT 1 FROM ledger_entries e JOIN accounts a ON a.id=e.account_id WHERE e.transaction_id=t.id AND a.user_id=$1) " +
    "ORDER BY t.id DESC LIMIT $2", [req.user!.id, limit]
  )).rows);
});