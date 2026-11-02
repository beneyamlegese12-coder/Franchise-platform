import { Router } from "express";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { pool, withTx } from "../db/pool.js";
import { auth } from "../auth.js";
import { post } from "../services/ledger.js";
import { normalizePhone } from "../phone.js";
import { HttpError } from "../errors.js";

export const network = Router();

// Admin manages super agents, a super agent manages their own club agents
const parentsOnly = auth(["admin", "super"]);
const childRole = (role: string) => (role === "admin" ? "super" : "club");

network.get("/network/agents", parentsOnly, async (req, res) => {
  const me = req.user!;
  const rows = (await pool.query(
    "SELECT u.id, u.display_name AS name, u.phone, u.status, u.created_at, COALESCE(a.balance_minor, 0) AS balance_minor " +
    "FROM users u LEFT JOIN accounts a ON a.user_id=u.id AND a.type='credit' " +
    "WHERE u.role=$1 AND ($2 OR u.parent_id=$3) ORDER BY u.display_name",
    [childRole(me.role), me.role === "admin", me.id]
  )).rows;
  res.json(rows);
});

const move = z.object({
  user_id: z.number().int().positive(),
  amount_minor: z.number().int().min(100, "The minimum is $1.00").max(100_000_000_000),
  note: z.string().trim().max(200).optional(),
});

async function transfer(req: Request, res: Response, dir: "fund" | "clawback") {
  const p = move.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: p.error.issues[0].message }); return; }
  const me = req.user!;
  try {
    const out = await withTx(async (c) => {
      const t = (await c.query(
        "SELECT id, display_name, status FROM users WHERE id=$1 AND role=$2 AND ($3 OR parent_id=$4)",
        [p.data.user_id, childRole(me.role), me.role === "admin", me.id]
      )).rows[0];
      if (!t) throw new HttpError(404, "That agent is not one of yours");
      if (dir === "fund" && t.status !== "active") throw new HttpError(409, "That agent is " + t.status + ". Unfreeze them before sending points.");
      const acct = async (uid: number, type: string) => {
        const a = await c.query("SELECT id FROM accounts WHERE user_id=$1 AND type=$2", [uid, type]);
        if (!a.rowCount) throw new HttpError(500, "Missing " + type + " account");
        return a.rows[0].id as number;
      };
      // An admin's points come from, and go back to, the mint account. A super agent uses their own balance.
      const mine = await acct(me.id, me.role === "admin" ? "mint" : "credit");
      const theirs = await acct(t.id, "credit");
      const amt = p.data.amount_minor;
      const tx = await post(c, {
        kind: dir === "fund" ? "points_fund" : "points_clawback",
        key: (dir === "fund" ? "points-fund:" : "points-clawback:") + randomUUID(),
        memo: (dir === "fund" ? "Points sent to " : "Points taken back from ") + t.display_name + (p.data.note ? ": " + p.data.note : ""),
        createdBy: me.id,
        entries: dir === "fund" ? [{ accountId: mine, amount: -amt }, { accountId: theirs, amount: amt }] : [{ accountId: theirs, amount: -amt }, { accountId: mine, amount: amt }],
      });
      await c.query(
        "INSERT INTO audit_logs (actor_id, action, entity, entity_id, detail) VALUES ($1,$2,'user',$3,$4)",
        [me.id, dir === "fund" ? "fund_agent" : "clawback_agent", t.id, JSON.stringify({ amount_minor: amt, note: p.data.note ?? null, transaction_id: tx.id })]
      );
      return { transaction_id: tx.id, amount_minor: amt, agent: t.display_name };
    });
    res.status(201).json(out);
  } catch (e: any) {
    if (e?.code === "23514") throw new HttpError(409, dir === "fund" ? "You do not have enough points for this transfer" : "That agent does not hold that many points");
    throw e;
  }
}
network.post("/network/fund", parentsOnly, (req, res) => transfer(req, res, "fund"));
network.post("/network/clawback", parentsOnly, (req, res) => transfer(req, res, "clawback"));

// A super agent registers a club agent under themselves
function weak(pw: string): string | null {
  if (pw.length < 10) return "Password must be at least 10 characters";
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/[0-9]/.test(pw)) return "Password needs upper case, lower case and a number";
  return null;
}
network.post("/network/clubs", auth(["super"]), async (req, res) => {
  const p = z.object({
    phone: z.string().min(1, "Enter a phone number").max(40),
    display_name: z.string().trim().min(1, "Enter the club name").max(60),
    password: z.string().min(1, "Choose a password").max(100),
    cbe_account: z.string().trim().max(40).optional(),
    deposit_rate_bps: z.number().int().min(0).max(10000).optional(),
    withdrawal_rate_bps: z.number().int().min(0).max(10000).optional(),
    initial_points_minor: z.number().int().min(0).max(100_000_000_000).optional(),
  }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: p.error.issues[0].message }); return; }
  const me = req.user!;
  const phone = normalizePhone(p.data.phone);
  if (!phone) throw new HttpError(400, "Enter a valid Ethiopian mobile number, for example 0912345678");
  const bad = weak(p.data.password);
  if (bad) throw new HttpError(400, bad);
  if (p.data.password.includes(phone.slice(4))) throw new HttpError(400, "The password must not contain the phone number");
  if (p.data.cbe_account && p.data.cbe_account.length < 6) throw new HttpError(400, "Enter the full CBE account number");
  // A club agent's rate can never be above the super agent's own rate
  const mine = (await pool.query("SELECT event_type, rate_bps FROM commission_rates WHERE user_id=$1", [me.id])).rows;
  const myDep = (mine.find((r) => r.event_type === "deposit")?.rate_bps ?? 0) as number;
  const myWd = (mine.find((r) => r.event_type === "withdrawal")?.rate_bps ?? 0) as number;
  const dep = p.data.deposit_rate_bps ?? (Number(process.env.NEW_CLUB_DEPOSIT_BPS) || 0);
  const wd = p.data.withdrawal_rate_bps ?? (Number(process.env.NEW_CLUB_WITHDRAWAL_BPS) || 0);
  if (dep > myDep) throw new HttpError(400, "Your own deposit rate is " + myDep / 100 + "%, so a club agent cannot be set higher");
  if (wd > myWd) throw new HttpError(400, "Your own withdrawal rate is " + myWd / 100 + "%, so a club agent cannot be set higher");
  const init = p.data.initial_points_minor ?? 0;
  try {
    const hash = await bcrypt.hash(p.data.password, 12);
    const id = await withTx(async (c) => {
      const u = await c.query(
        "INSERT INTO users (role, parent_id, username, phone, display_name, password_hash) VALUES ('club',$1,$2,$2,$3,$4) RETURNING id",
        [me.id, phone, p.data.display_name, hash]
      );
      const uid = u.rows[0].id as number;
      await c.query("INSERT INTO accounts (user_id, type) VALUES ($1,'credit'), ($1,'commission')", [uid]);
      await c.query(
        "INSERT INTO commission_rates (user_id, event_type, rate_bps, cap_bps) VALUES ($1,'deposit',$2,$2), ($1,'withdrawal',$3,$3)",
        [uid, dep, wd]
      );
      if (p.data.cbe_account) {
        await c.query("INSERT INTO agent_channels (user_id, channel, phone, account_no) VALUES ($1,'CBE',$2,$3)", [uid, phone, p.data.cbe_account]);
      }
      if (init > 0) {
        const from = (await c.query("SELECT id FROM accounts WHERE user_id=$1 AND type='credit'", [me.id])).rows[0]?.id;
        const to = (await c.query("SELECT id FROM accounts WHERE user_id=$1 AND type='credit'", [uid])).rows[0]?.id;
        await post(c, {
          kind: "points_fund", key: "points-fund:" + randomUUID(), memo: "Initial top-up for " + p.data.display_name, createdBy: me.id,
          entries: [{ accountId: from, amount: -init }, { accountId: to, amount: init }],
        });
      }
      await c.query("INSERT INTO audit_logs (actor_id, action, entity, entity_id, detail) VALUES ($1,'create_club','user',$2,$3)", [me.id, uid, JSON.stringify({ initial_points_minor: init })]);
      return uid;
    });
    res.status(201).json({ id });
  } catch (e: any) {
    if (e?.code === "23505") { res.status(409).json({ error: "That phone number is already registered" }); return; }
    if (e?.code === "23514") { res.status(409).json({ error: "You do not have enough points for that top-up" }); return; }
    throw e;
  }
});