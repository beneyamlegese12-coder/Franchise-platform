import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { auth } from "../auth.js";
import { runSettlement } from "../services/settlement.js";
import { reverseRequest } from "../services/reversals.js";

export const money = Router();
const only = auth(["admin"]);

money.get("/admin/unsettled", only, async (_req, res) => {
  const r = await pool.query(
    "SELECT u.id, u.display_name AS name, u.role, SUM(r.amount_minor)::bigint AS accrued_minor " +
    "FROM commission_records r JOIN users u ON u.id=r.beneficiary_user_id " +
    "WHERE r.status='accrued' AND r.amount_minor > 0 GROUP BY u.id ORDER BY u.id"
  );
  res.json(r.rows);
});

money.get("/admin/settlements", only, async (_req, res) => {
  const r = await pool.query(
    "SELECT id, to_char(run_date,'YYYY-MM-DD') AS run_date, trigger, total_minor, users_count, created_at " +
    "FROM settlement_runs ORDER BY id DESC LIMIT 30"
  );
  res.json(r.rows);
});

money.post("/admin/settle", only, async (req, res) => {
  const out = await runSettlement("manual", req.user!.id);
  res.status(201).json(out);
});

money.post("/admin/reversals", only, async (req, res) => {
  const p = z.object({
    point_request_id: z.number().int().positive(),
    reason: z.string().min(3, "Please give a reason (at least 3 characters)").max(200),
  }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: p.error.issues[0].message }); return; }
  res.json(await reverseRequest(p.data.point_request_id, req.user!.id, p.data.reason));
});