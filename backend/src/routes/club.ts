import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { normalizePhone } from "../phone.js";
import { pool, withTx } from "../db/pool.js";
import { auth } from "../auth.js";
import { HttpError } from "../errors.js";

export const club = Router();

club.get("/club/overview", auth(["club"]), async (req, res) => {
  const id = req.user!.id;
  const bal = async (type: string) =>
    (await pool.query("SELECT balance_minor AS v FROM accounts WHERE user_id=$1 AND type=$2", [id, type])).rows[0].v as number;
  const players = (await pool.query("SELECT COUNT(*)::bigint AS v FROM users WHERE parent_id=$1 AND role='player'", [id])).rows[0].v;
  const pending = (await pool.query("SELECT COUNT(*)::bigint AS v FROM point_requests WHERE club_id=$1 AND status='pending'", [id])).rows[0].v;
  const turnover = (await pool.query(
    "SELECT COALESCE(SUM(b.amount_minor),0)::bigint AS v FROM bets b JOIN users p ON p.id=b.player_id WHERE p.parent_id=$1 AND b.status='settled'", [id]
  )).rows[0].v;
  res.json({
    credit_balance_minor: await bal("credit"),
    commission_balance_minor: await bal("commission"),
    players,
    pending_requests: pending,
    turnover_minor: turnover,
  });
});

club.get("/players", auth(["club"]), async (req, res) => {
  const r = await pool.query(
    "SELECT u.id, u.username, u.display_name AS name, u.status, u.created_at, " +
    "(SELECT balance_minor FROM accounts a WHERE a.user_id=u.id AND a.type='credit') AS credit_balance_minor " +
    "FROM users u WHERE u.parent_id=$1 AND u.role='player' ORDER BY u.id",
    [req.user!.id]
  );
  res.json(r.rows);
});

club.post("/players", auth(["club"]), async (req, res) => {
  const p = z.object({
    phone: z.string().min(1, "Enter a phone number").max(40),
    display_name: z.string().min(1).max(60),
    password: z.string().min(8).max(100),
  }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: p.error.issues[0].message }); return; }
  try {
    const phoneN = normalizePhone(p.data.phone);
    if (!phoneN) { res.status(400).json({ error: "Enter a valid Ethiopian mobile number, for example 0912345678" }); return; }
    const hash = await bcrypt.hash(p.data.password, 10);
    const id = await withTx(async (c) => {
      const u = await c.query(
        "INSERT INTO users (role, parent_id, username, phone, display_name, password_hash) VALUES ('player',$1,$2,$2,$3,$4) RETURNING id",
        [req.user!.id, phoneN, p.data.display_name, hash]
      );
      await c.query("INSERT INTO accounts (user_id, type) VALUES ($1,'credit'), ($1,'hold')", [u.rows[0].id]);
      await c.query("INSERT INTO audit_logs (actor_id, action, entity, entity_id) VALUES ($1,'create_player','user',$2)", [req.user!.id, u.rows[0].id]);
      return u.rows[0].id as number;
    });
    res.status(201).json({ id });
  } catch (e: any) {
    if (e?.code === "23505") { res.status(409).json({ error: "That phone number is already registered" }); return; }
    throw e;
  }
});

club.post("/players/:id/status", auth(["club"]), async (req, res) => {
  const p = z.object({ status: z.enum(["active", "frozen"]) }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "Status must be active or frozen" }); return; }
  const r = await pool.query(
    "UPDATE users SET status=$1 WHERE id=$2 AND parent_id=$3 AND role='player' RETURNING id",
    [p.data.status, Number(req.params.id), req.user!.id]
  );
  if (!r.rowCount) throw new HttpError(404, "Player not found");
  await pool.query(
    "INSERT INTO audit_logs (actor_id, action, entity, entity_id, detail) VALUES ($1,'set_player_status','user',$2,$3)",
    [req.user!.id, r.rows[0].id, JSON.stringify({ status: p.data.status })]
  );
  res.json({ id: r.rows[0].id, status: p.data.status });
});

club.post("/point-requests/:id/reject", auth(["club", "admin"]), async (req, res) => {
  const isAdmin = req.user!.role === "admin";
  const r = await pool.query(
    "UPDATE point_requests SET status='rejected', decided_at=now(), decided_by=$2 " +
    "WHERE id=$1 AND status='pending' AND ($3 OR club_id=$2) RETURNING id",
    [Number(req.params.id), req.user!.id, isAdmin]
  );
  if (!r.rowCount) throw new HttpError(404, "No pending request with that id");
  await pool.query("INSERT INTO audit_logs (actor_id, action, entity, entity_id) VALUES ($1,'reject_point_request','point_request',$2)", [req.user!.id, r.rows[0].id]);
  res.json({ id: r.rows[0].id, status: "rejected" });
});