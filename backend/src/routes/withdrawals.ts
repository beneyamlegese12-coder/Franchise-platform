import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { auth } from "../auth.js";
import { requestWithdrawal, approveWithdrawal, rejectWithdrawal } from "../services/withdrawals.js";

export const withdrawals = Router();

withdrawals.post("/withdrawals", auth(["player"]), async (req, res) => {
  const p = z.object({ amount_minor: z.number().int().positive().max(100_000_000) }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "amount_minor must be a positive whole number" }); return; }
  res.status(201).json(await requestWithdrawal(req.user!.id, p.data.amount_minor));
});

const isWithdrawal = async (id: number) =>
  (await pool.query("SELECT 1 FROM point_requests WHERE id=$1 AND type='withdrawal'", [id])).rowCount === 1;

// Deposits fall through (next) to the existing handlers.
withdrawals.post("/point-requests/:id/approve", auth(["club", "admin"]), async (req, res, next) => {
  const id = Number(req.params.id);
  if (!(await isWithdrawal(id))) { next(); return; }
  res.json(await approveWithdrawal(id, req.user!.id, req.user!.role));
});

withdrawals.post("/point-requests/:id/reject", auth(["club", "admin"]), async (req, res, next) => {
  const id = Number(req.params.id);
  if (!(await isWithdrawal(id))) { next(); return; }
  res.json(await rejectWithdrawal(id, req.user!.id, req.user!.role));
});