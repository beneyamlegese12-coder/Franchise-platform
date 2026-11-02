import { Router } from "express";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { pool, withTx } from "../db/pool.js";
import { auth } from "../auth.js";
import { post } from "../services/ledger.js";
import { normalizePhone } from "../phone.js";
import { HttpError } from "../errors.js";

export const adminDash = Router();
const only = auth(["admin"]);
const CATEGORIES = ["Slots", "Live Casino", "Sportsbook", "Crash Games", "Table Games"];

// One row per ledger transaction: who paid, who received, how much
const OPS_SQL =
  "SELECT t.id, t.kind, t.memo, t.created_at, " +
  "(SELECT COALESCE(SUM(e.amount_minor),0)::bigint FROM ledger_entries e WHERE e.transaction_id=t.id AND e.amount_minor>0) AS amount_minor, " +
  "(SELECT string_agg(DISTINCT u.display_name, ', ') FROM ledger_entries e JOIN accounts a ON a.id=e.account_id JOIN users u ON u.id=a.user_id WHERE e.transaction_id=t.id AND e.amount_minor<0) AS sender, " +
  "(SELECT string_agg(DISTINCT u.display_name, ', ') FROM ledger_entries e JOIN accounts a ON a.id=e.account_id JOIN users u ON u.id=a.user_id WHERE e.transaction_id=t.id AND e.amount_minor>0) AS receiver " +
  "FROM ledger_transactions t ORDER BY t.id DESC LIMIT $1";

const num = async (sql: string) => (await pool.query(sql)).rows[0].v as number;

adminDash.get("/admin/dashboard", only, async (_req, res) => {
  const totals = (await pool.query(
    "SELECT COALESCE(SUM(amount_minor) FILTER (WHERE status='settled'),0)::bigint AS turnover, " +
    "COALESCE(SUM(win_minor) FILTER (WHERE status='settled'),0)::bigint AS wins FROM bets"
  )).rows[0];
  const byProvider = (await pool.query(
    "SELECT g.category, g.provider, COALESCE(p.fee_bps,0)::int AS fee_bps, COUNT(*)::int AS bets, " +
    "COALESCE(SUM(b.amount_minor),0)::bigint AS turnover, COALESCE(SUM(b.win_minor),0)::bigint AS wins " +
    "FROM bets b JOIN games g ON g.slug=b.game_id LEFT JOIN providers p ON p.name=g.provider " +
    "WHERE b.status='settled' GROUP BY g.category, g.provider, p.fee_bps"
  )).rows;

  const verticals = CATEGORIES.map((c) => {
    const rows = byProvider.filter((r) => r.category === c);
    const turnover = rows.reduce((s, r) => s + r.turnover, 0);
    const wins = rows.reduce((s, r) => s + r.wins, 0);
    return { category: c, bets: rows.reduce((s, r) => s + r.bets, 0), turnover_minor: turnover, ggr_minor: turnover - wins };
  });
  const matched = verticals.reduce((s, v) => s + v.turnover_minor, 0);
  if (totals.turnover - matched > 0) {
    verticals.push({ category: "Other", bets: 0, turnover_minor: totals.turnover - matched, ggr_minor: 0 });
  }
  // Report only: each provider's fee share of the GGR it generated
  const betting = byProvider.reduce((s, r) => s + Math.round(((r.turnover - r.wins) * r.fee_bps) / 10000), 0);

  const cash = (await pool.query(
    "SELECT event_type, COALESCE(SUM(amount_minor),0)::bigint AS v FROM commission_records WHERE level='admin' AND status<>'reversed' GROUP BY event_type"
  )).rows;
  const cashOf = (t: string) => (cash.find((r) => r.event_type === t)?.v ?? 0) as number;

  const supers = (await pool.query(
    "SELECT u.id, u.display_name AS name, u.phone, COALESCE(d.rate_bps,0)::int AS dep_bps, COALESCE(w.rate_bps,0)::int AS wd_bps, COALESCE(a.balance_minor,0)::bigint AS balance_minor " +
    "FROM users u LEFT JOIN commission_rates d ON d.user_id=u.id AND d.event_type='deposit' " +
    "LEFT JOIN commission_rates w ON w.user_id=u.id AND w.event_type='withdrawal' " +
    "LEFT JOIN accounts a ON a.user_id=u.id AND a.type='credit' WHERE u.role='super' ORDER BY u.display_name"
  )).rows;
  const timeline = (await pool.query(
    "SELECT to_char(date_trunc('day', created_at),'YYYY-MM-DD') AS day, (SUM(amount_minor) - SUM(win_minor))::bigint AS ggr_minor " +
    "FROM bets WHERE status='settled' AND created_at > now() - interval '14 days' GROUP BY 1 ORDER BY 1"
  )).rows;
  const fees = (await pool.query("SELECT MIN(fee_bps)::int AS lo, MAX(fee_bps)::int AS hi FROM providers WHERE status='active'")).rows[0];
  const ledger = (await pool.query(OPS_SQL, [8])).rows;
  const base = process.env.PUBLIC_API_URL || ("http://localhost:" + (process.env.PORT || 4000));

  res.json({
    turnover_minor: totals.turnover, wins_minor: totals.wins, ggr_minor: totals.turnover - totals.wins,
    minted_minor: await num("SELECT -COALESCE(SUM(balance_minor),0)::bigint AS v FROM accounts WHERE type='mint'"),
    royalty: { betting_minor: betting, deposit_minor: cashOf("deposit"), withdrawal_minor: cashOf("withdrawal") },
    fee_range: { lo_bps: fees?.lo ?? 0, hi_bps: fees?.hi ?? 0 },
    network: {
      super_agents: await num("SELECT COUNT(*)::bigint AS v FROM users WHERE role='super'"),
      club_agents: await num("SELECT COUNT(*)::bigint AS v FROM users WHERE role='club'"),
      players: await num("SELECT COUNT(*)::bigint AS v FROM users WHERE role='player'"),
    },
    pending_requests: await num("SELECT COUNT(*)::bigint AS v FROM point_requests WHERE status='pending'"),
    pending_point_asks: await num("SELECT COUNT(*)::bigint AS v FROM point_asks WHERE status='pending' AND requester_role='super'"),
    verticals, timeline, supers, ledger,
    api: { games_url: base + "/api/v1/games", wallet_url: base + "/api/v1/wallet" },
  });
});

adminDash.get("/admin/ledger-ops", only, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  res.json((await pool.query(OPS_SQL, [limit])).rows);
});

adminDash.get("/admin/cashier-log", only, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
  const rows = (await pool.query(
    "SELECT pr.id, pr.type, pr.amount_minor, pr.status, pr.channel, pr.player_phone, pr.player_account, pr.transfer_ref, pr.created_at, " +
    "(pr.claim_expires_at > now()) AS live, pr.claimed_by, p.display_name AS player, p.id AS player_id, c.display_name AS club " +
    "FROM point_requests pr JOIN users p ON p.id=pr.player_id " +
    "LEFT JOIN users c ON c.id = COALESCE(pr.claimed_by, CASE WHEN pr.status <> 'pending' THEN pr.club_id END) " +
    "ORDER BY pr.created_at DESC LIMIT $1", [limit]
  )).rows;
  res.json(rows.map((r) => ({
    id: r.id, type: r.type, amount_minor: r.amount_minor, channel: r.channel, created_at: r.created_at,
    player: r.player, player_id: r.player_id, club: r.status === "pending" && !(r.live && r.claimed_by) ? null : r.club,
    status: r.status === "pending" ? (r.live && r.claimed_by ? "CLAIMED" : "PENDING") : String(r.status).toUpperCase(),
    reference: r.transfer_ref, phone: r.player_phone, account: r.player_account,
  })));
});

adminDash.get("/admin/directory", only, async (_req, res) => {
  res.json((await pool.query(
    "SELECT u.id, u.role, u.username, u.phone, u.display_name AS name, u.status, p.display_name AS parent, " +
    "(SELECT balance_minor FROM accounts a WHERE a.user_id=u.id AND a.type='credit') AS balance_minor, " +
    "(SELECT rate_bps FROM commission_rates r WHERE r.user_id=u.id AND r.event_type='deposit') AS dep_bps, " +
    "(SELECT cap_bps FROM commission_rates r WHERE r.user_id=u.id AND r.event_type='deposit') AS dep_cap_bps, " +
    "(SELECT rate_bps FROM commission_rates r WHERE r.user_id=u.id AND r.event_type='withdrawal') AS wd_bps, " +
    "(SELECT cap_bps FROM commission_rates r WHERE r.user_id=u.id AND r.event_type='withdrawal') AS wd_cap_bps, " +
    "(SELECT account_no FROM agent_channels ch WHERE ch.user_id=u.id AND ch.channel='CBE') AS cbe_account " +
    "FROM users u LEFT JOIN users p ON p.id=u.parent_id WHERE u.role <> 'admin' " +
    "ORDER BY CASE u.role WHEN 'super' THEN 1 WHEN 'club' THEN 2 ELSE 3 END, u.id LIMIT 1000"
  )).rows);
});

// ---- Provision a super agent in one step ----
function weak(pw: string): string | null {
  if (pw.length < 10) return "Password must be at least 10 characters";
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/[0-9]/.test(pw)) return "Password needs upper case, lower case and a number";
  return null;
}
adminDash.post("/admin/provision-super", only, async (req, res) => {
  const p = z.object({
    phone: z.string().min(1, "Enter a phone number").max(40),
    display_name: z.string().trim().min(1, "Enter the agency name").max(60),
    password: z.string().min(1, "Choose a password").max(100),
    cbe_account: z.string().trim().max(40).optional(),
    deposit_rate_bps: z.number().int().min(0).max(2000, "The maximum rate is 20%"),
    withdrawal_rate_bps: z.number().int().min(0).max(2000, "The maximum rate is 20%"),
    initial_points_minor: z.number().int().min(0).max(100_000_000_000).optional(),
  }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: p.error.issues[0].message }); return; }
  const phone = normalizePhone(p.data.phone);
  if (!phone) throw new HttpError(400, "Enter a valid Ethiopian mobile number, for example 0912345678");
  const bad = weak(p.data.password);
  if (bad) throw new HttpError(400, bad);
  if (p.data.password.includes(phone.slice(4))) throw new HttpError(400, "The password must not contain the phone number");
  if (p.data.cbe_account && p.data.cbe_account.length < 6) throw new HttpError(400, "Enter the full CBE account number");
  const me = req.user!;
  try {
    const hash = await bcrypt.hash(p.data.password, 12);
    const out = await withTx(async (c) => {
      const u = await c.query(
        "INSERT INTO users (role, parent_id, username, phone, display_name, password_hash) VALUES ('super',$1,$2,$2,$3,$4) RETURNING id",
        [me.id, phone, p.data.display_name, hash]
      );
      const uid = u.rows[0].id as number;
      await c.query("INSERT INTO accounts (user_id, type) VALUES ($1,'credit'), ($1,'commission')", [uid]);
      await c.query(
        "INSERT INTO commission_rates (user_id, event_type, rate_bps, cap_bps) VALUES ($1,'deposit',$2,$2), ($1,'withdrawal',$3,$3)",
        [uid, p.data.deposit_rate_bps, p.data.withdrawal_rate_bps]
      );
      if (p.data.cbe_account) {
        await c.query("INSERT INTO agent_channels (user_id, channel, phone, account_no) VALUES ($1,'CBE',$2,$3)", [uid, phone, p.data.cbe_account]);
      }
      let tx: number | null = null;
      if ((p.data.initial_points_minor ?? 0) > 0) {
        const mint = (await c.query("SELECT id FROM accounts WHERE user_id=$1 AND type='mint'", [me.id])).rows[0]?.id;
        const dest = (await c.query("SELECT id FROM accounts WHERE user_id=$1 AND type='credit'", [uid])).rows[0]?.id;
        if (!mint || !dest) throw new HttpError(500, "Missing mint or credit account");
        const amt = p.data.initial_points_minor as number;
        tx = (await post(c, {
          kind: "mint", key: "mint:" + randomUUID(), memo: "Initial allocation for " + p.data.display_name, createdBy: me.id,
          entries: [{ accountId: mint, amount: -amt }, { accountId: dest, amount: amt }],
        })).id;
      }
      await c.query(
        "INSERT INTO audit_logs (actor_id, action, entity, entity_id, detail) VALUES ($1,'provision_super','user',$2,$3)",
        [me.id, uid, JSON.stringify({ initial_points_minor: p.data.initial_points_minor ?? 0, transaction_id: tx })]
      );
      return { id: uid, transaction_id: tx };
    });
    res.status(201).json(out);
  } catch (e: any) {
    if (e?.code === "23505") { res.status(409).json({ error: "That phone number is already registered" }); return; }
    throw e;
  }
});

// ---- Providers ----
function safeUrl(u: string): URL {
  let x: URL;
  try { x = new URL(u); } catch { throw new HttpError(400, "Enter a valid web address"); }
  if (x.protocol !== "https:") throw new HttpError(400, "The address must start with https://");
  const h = x.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1)/.test(h)) {
    throw new HttpError(400, "That address points to a private network");
  }
  return x;
}

adminDash.get("/admin/providers", only, async (_req, res) => {
  res.json((await pool.query(
    "SELECT p.id, p.code, p.name, p.category, p.api_endpoint, p.fee_bps, p.status, p.latency_ms, p.last_ping_at, " +
    "(SELECT COUNT(*)::int FROM games g WHERE g.provider=p.name AND g.active) AS games " +
    "FROM providers p ORDER BY p.id"
  )).rows);
});

adminDash.post("/admin/providers/:id/status", only, async (req, res) => {
  const p = z.object({ status: z.enum(["active", "disabled"]) }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "Status must be active or disabled" }); return; }
  const r = await pool.query("UPDATE providers SET status=$2 WHERE id=$1 RETURNING id, name", [Number(req.params.id), p.data.status]);
  if (!r.rowCount) throw new HttpError(404, "Provider not found");
  await pool.query("INSERT INTO audit_logs (actor_id, action, entity, entity_id, detail) VALUES ($1,$2,'provider',$3,$4)",
    [req.user!.id, p.data.status === "active" ? "enable_provider" : "disable_provider", r.rows[0].id, JSON.stringify({ name: r.rows[0].name })]);
  res.json({ id: r.rows[0].id, status: p.data.status });
});

adminDash.put("/admin/providers/:id", only, async (req, res) => {
  const p = z.object({ api_endpoint: z.string().max(300).optional(), fee_bps: z.number().int().min(0).max(5000).optional() }).safeParse(req.body);
  if (!p.success || (p.data.api_endpoint === undefined && p.data.fee_bps === undefined)) { res.status(400).json({ error: "Enter a web address or a fee between 0% and 50%" }); return; }
  if (p.data.api_endpoint !== undefined) safeUrl(p.data.api_endpoint);
  const r = await pool.query(
    "UPDATE providers SET api_endpoint=COALESCE($2, api_endpoint), fee_bps=COALESCE($3, fee_bps) WHERE id=$1 RETURNING id, name",
    [Number(req.params.id), p.data.api_endpoint ?? null, p.data.fee_bps ?? null]
  );
  if (!r.rowCount) throw new HttpError(404, "Provider not found");
  await pool.query("INSERT INTO audit_logs (actor_id, action, entity, entity_id, detail) VALUES ($1,'edit_provider','provider',$2,$3)",
    [req.user!.id, r.rows[0].id, JSON.stringify({ name: r.rows[0].name, fee_bps: p.data.fee_bps ?? null, api_endpoint: p.data.api_endpoint ?? null })]);
  res.json({ id: r.rows[0].id });
});

adminDash.post("/admin/providers/:id/ping", only, async (req, res) => {
  const p = (await pool.query("SELECT id, api_endpoint FROM providers WHERE id=$1", [Number(req.params.id)])).rows[0];
  if (!p) throw new HttpError(404, "Provider not found");
  const url = safeUrl(p.api_endpoint);
  const t0 = Date.now();
  let latency: number | null = null;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    await fetch(url, { method: "HEAD", signal: ctl.signal, redirect: "manual" });
    clearTimeout(timer);
    latency = Date.now() - t0;
  } catch { latency = null; }
  await pool.query("UPDATE providers SET latency_ms=$2, last_ping_at=now() WHERE id=$1", [p.id, latency]);
  res.json({ latency_ms: latency, reachable: latency !== null });
});

// ---- Aggregator secret: shown only after the admin re-enters their password ----
const tries = new Map<number, { n: number; t: number }>();
adminDash.post("/admin/aggregator-secret", only, async (req, res) => {
  const me = req.user!;
  const now = Date.now();
  const t = tries.get(me.id);
  if (t && now - t.t < 60_000 && t.n >= 5) throw new HttpError(429, "Too many attempts. Wait a minute and try again.");
  tries.set(me.id, !t || now - t.t >= 60_000 ? { n: 1, t: now } : { n: t.n + 1, t: t.t });
  const p = z.object({ password: z.string().min(1).max(200) }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "Enter your password" }); return; }
  const row = (await pool.query("SELECT password_hash FROM users WHERE id=$1", [me.id])).rows[0];
  if (!row || !(await bcrypt.compare(p.data.password, row.password_hash))) throw new HttpError(403, "Wrong password");
  await pool.query("INSERT INTO audit_logs (actor_id, action, entity, entity_id) VALUES ($1,'reveal_aggregator_secret','system',$1)", [me.id]);
  res.json({ secret: process.env.AGGREGATOR_SECRET ?? "" });
});