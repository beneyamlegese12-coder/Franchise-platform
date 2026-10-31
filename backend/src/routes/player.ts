import { Router } from "express";
import { pool } from "../db/pool.js";
import { auth } from "../auth.js";
import { HttpError } from "../errors.js";

export const player = Router();

player.get("/player/overview", auth(["player"]), async (req, res) => {
  const id = req.user!.id;
  const bal = async (type: string) =>
    (await pool.query("SELECT balance_minor AS v FROM accounts WHERE user_id=$1 AND type=$2", [id, type])).rows[0]?.v ?? 0;
  const me = (await pool.query(
    "SELECT u.display_name AS name, u.status, c.display_name AS club FROM users u JOIN users c ON c.id=u.parent_id WHERE u.id=$1", [id]
  )).rows[0];
  const pending = (await pool.query("SELECT COUNT(*)::bigint AS v FROM point_requests WHERE player_id=$1 AND status='pending'", [id])).rows[0].v;
  res.json({
    name: me.name,
    club: me.club,
    status: me.status,
    credit_balance_minor: await bal("credit"),
    held_minor: await bal("hold"),
    pending_requests: pending,
  });
});

// Frozen or banned players cannot create deposit requests, even with an older login.
// Then the request carries on to the normal handler (next).
player.post("/point-requests", auth(["player"]), async (req, res, next) => {
  const s = (await pool.query("SELECT status FROM users WHERE id=$1", [req.user!.id])).rows[0]?.status;
  if (s !== "active") throw new HttpError(403, "Your account is " + s + ". Please contact your club agent.");
  next();
});