import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { auth } from "../auth.js";
import { HttpError } from "../errors.js";
import { LIMIT_KINDS, COOLING_HOURS, applyMatured, usage, assertCanDeposit, assertCanWithdraw, needKyc, minAge } from "../services/rg.js";

export const rg = Router();

const log = (actor: number, action: string, id: number | null, detail?: unknown) =>
  pool.query("INSERT INTO audit_logs (actor_id, action, entity, entity_id, detail) VALUES ($1,$2,'user',$3,$4)", [actor, action, id, detail ? JSON.stringify(detail) : null]);

// ---- Checks that run before the normal handlers (they hand on with next) ----
rg.post("/point-requests", auth(["player"]), async (req, res, next) => {
  const a = Number(req.body?.amount_minor);
  if (Number.isInteger(a) && a > 0) await assertCanDeposit(pool, req.user!.id, a, true);
  next();
});
rg.post("/withdrawals", auth(["player"]), async (req, _res, next) => {
  await assertCanWithdraw(pool, req.user!.id);
  next();
});
rg.post("/point-requests/:id/approve", auth(["club", "admin"]), async (req, _res, next) => {
  const r = (await pool.query("SELECT player_id, type, status, amount_minor FROM point_requests WHERE id=$1", [Number(req.params.id)])).rows[0];
  if (r && r.type === "deposit" && r.status === "pending") await assertCanDeposit(pool, r.player_id, r.amount_minor, false);
  next();
});

// ---- Player: limits and self-exclusion ----
rg.get("/player/limits", auth(["player"]), async (req, res) => {
  const id = req.user!.id;
  await applyMatured(pool, id);
  const u = (await pool.query("SELECT kyc_status, excluded_until FROM users WHERE id=$1", [id])).rows[0];
  const rows = (await pool.query("SELECT kind, amount_minor, pending_amount_minor, pending_from FROM player_limits WHERE user_id=$1", [id])).rows;
  const use = await usage(pool, id);
  res.json({
    kyc_status: u.kyc_status,
    kyc_required: needKyc(),
    excluded_until: u.excluded_until && new Date(u.excluded_until) > new Date() ? u.excluded_until : null,
    limits: LIMIT_KINDS.map((k) => rows.find((r) => r.kind === k) ?? { kind: k, amount_minor: null, pending_amount_minor: null, pending_from: null }),
    usage: { deposit_day: use.d1 + use.pending, deposit_week: use.d7 + use.pending, deposit_month: use.d30 + use.pending, loss_day: use.loss },
  });
});

// Lower = immediate. Higher or removed = waits for the cooling-off period.
rg.put("/player/limits", auth(["player"]), async (req, res) => {
  const p = z.object({ kind: z.enum(LIMIT_KINDS), amount_minor: z.number().int().min(0).max(100_000_000_000) }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "Choose a limit type and an amount" }); return; }
  const { kind, amount_minor: a } = p.data;
  const id = req.user!.id;
  await applyMatured(pool, id);
  const cur = (await pool.query("SELECT amount_minor FROM player_limits WHERE user_id=$1 AND kind=$2", [id, kind])).rows[0];
  if (!cur) {
    if (a === 0) throw new HttpError(400, "There is no limit to remove");
    await pool.query("INSERT INTO player_limits (user_id, kind, amount_minor) VALUES ($1,$2,$3)", [id, kind, a]);
    await log(id, "set_limit", id, { kind, amount_minor: a });
    res.json({ applied: true });
    return;
  }
  if (a > 0 && a <= cur.amount_minor) {
    await pool.query("UPDATE player_limits SET amount_minor=$3, pending_amount_minor=NULL, pending_from=NULL WHERE user_id=$1 AND kind=$2", [id, kind, a]);
    await log(id, "lower_limit", id, { kind, amount_minor: a });
    res.json({ applied: true });
    return;
  }
  const r = await pool.query(
    "UPDATE player_limits SET pending_amount_minor=$3, pending_from=now() + make_interval(hours => $4) WHERE user_id=$1 AND kind=$2 RETURNING pending_from",
    [id, kind, a, COOLING_HOURS]
  );
  await log(id, a === 0 ? "request_limit_removal" : "request_limit_increase", id, { kind, amount_minor: a });
  res.json({ applied: false, effective_from: r.rows[0].pending_from });
});

rg.post("/player/exclude", auth(["player"]), async (req, res) => {
  const p = z.object({ days: z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(180), z.literal(365)]) }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "Choose 1, 7, 30, 180 or 365 days" }); return; }
  const r = await pool.query(
    "UPDATE users SET excluded_until = GREATEST(COALESCE(excluded_until, now()), now() + make_interval(days => $2)) WHERE id=$1 RETURNING excluded_until",
    [req.user!.id, p.data.days]
  );
  await log(req.user!.id, "self_exclude", req.user!.id, { days: p.data.days });
  res.json({ excluded_until: r.rows[0].excluded_until });
});

// ---- Identity and age checks (club agent for own players, admin for anyone) ----
const ageOf = (dob: string): number | null => {
  const d = new Date(dob + "T00:00:00Z");
  if (isNaN(d.getTime())) return null;
  const n = new Date();
  let a = n.getUTCFullYear() - d.getUTCFullYear();
  if (n.getUTCMonth() < d.getUTCMonth() || (n.getUTCMonth() === d.getUTCMonth() && n.getUTCDate() < d.getUTCDate())) a--;
  return a >= 0 && a <= 120 ? a : null;
};

rg.get("/kyc/players", auth(["club", "admin"]), async (req, res) => {
  const admin = req.user!.role === "admin";
  const r = await pool.query(
    "SELECT id, username, display_name AS name, kyc_status, to_char(date_of_birth,'YYYY-MM-DD') AS date_of_birth, kyc_verified_at, kyc_note, excluded_until " +
    "FROM users WHERE role='player' AND ($1 OR parent_id=$2) ORDER BY id",
    [admin, req.user!.id]
  );
  res.json(r.rows);
});

rg.post("/kyc/players/:id", auth(["club", "admin"]), async (req, res) => {
  const p = z.object({
    status: z.enum(["verified", "rejected"]),
    date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the date of birth as YYYY-MM-DD").optional(),
    note: z.string().max(200).optional(),
  }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: p.error.issues[0].message }); return; }
  const id = Number(req.params.id);
  const admin = req.user!.role === "admin";
  const t = await pool.query("SELECT id FROM users WHERE id=$1 AND role='player' AND ($2 OR parent_id=$3)", [id, admin, req.user!.id]);
  if (!t.rowCount) throw new HttpError(404, "Player not found");

  let status = p.data.status;
  let problem: string | null = null;
  if (status === "verified") {
    if (!p.data.date_of_birth) throw new HttpError(400, "Enter the date of birth to verify a player");
    const age = ageOf(p.data.date_of_birth);
    if (age === null) throw new HttpError(400, "That date of birth is not valid");
    if (age < minAge()) { status = "rejected"; problem = "This player is under " + minAge() + " and cannot be verified."; }
  }
  await pool.query(
    "UPDATE users SET kyc_status=$2, date_of_birth=COALESCE($3::date, date_of_birth), kyc_verified_by=$4, kyc_verified_at=now(), kyc_note=$5 WHERE id=$1",
    [id, status, p.data.date_of_birth ?? null, req.user!.id, problem ?? p.data.note ?? null]
  );
  await log(req.user!.id, "kyc_" + status, id, { note: p.data.note ?? null });
  if (problem) throw new HttpError(400, problem);
  res.json({ id, kyc_status: status });
});

// ---- Admin: lifting an exclusion early. Check your license before keeping this. ----
rg.post("/admin/users/:id/lift-exclusion", auth(["admin"]), async (req, res) => {
  const p = z.object({ reason: z.string().min(5).max(200) }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "Please give a reason (at least 5 characters)" }); return; }
  const id = Number(req.params.id);
  const r = await pool.query("UPDATE users SET excluded_until=NULL WHERE id=$1 AND role='player' RETURNING id", [id]);
  if (!r.rowCount) throw new HttpError(404, "Player not found");
  await log(req.user!.id, "lift_exclusion", id, { reason: p.data.reason });
  res.json({ id, excluded_until: null });
});