import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { pool, withTx } from "../db/pool.js";
import { auth } from "../auth.js";
import { post } from "../services/ledger.js";
import { requestWithdrawal } from "../services/withdrawals.js";
import { assertCanDeposit, assertCanWithdraw } from "../services/rg.js";
import { HttpError } from "../errors.js";

export const queue = Router();

const CHANNELS = ["CBE", "Telebirr", "Bank"] as const;
const PHONE = /^\+?[0-9 ]{7,16}$/;
const claimMinutes = () => Number(process.env.CLAIM_MINUTES) || 30;
const MAX_CLAIMS = 5; // most claims one agent can hold at once
const MAX_OPEN = 3;   // most open requests one player can have

const audit = (actor: number, action: string, id: number, detail?: unknown) =>
  pool.query(
    "INSERT INTO audit_logs (actor_id, action, entity, entity_id, detail) VALUES ($1,$2,'point_request',$3,$4)",
    [actor, action, id, detail ? JSON.stringify(detail) : null]
  );

// ---- Guard: a club agent can only approve or reject what they have claimed ----
async function mustHoldClaim(req: Request, res: Response, next: NextFunction) {
  const r = (await pool.query(
    "SELECT player_id, status, claimed_by, claim_expires_at FROM point_requests WHERE id=$1", [Number(req.params.id)]
  )).rows[0];
  if (req.user!.role === "club" && r && r.status === "pending") {
    if (Number(r.claimed_by) !== req.user!.id) throw new HttpError(403, "Claim this request first");
    if (new Date(r.claim_expires_at) < new Date()) throw new HttpError(409, "Your claim has expired. Claim it again if it is still open.");
  }
  // After a successful approval the player moves under the agent who served them
  if (r && r.claimed_by && req.path.endsWith("/approve")) {
    res.on("finish", () => {
      if (res.statusCode < 300) {
        pool.query("UPDATE users SET parent_id=$1 WHERE id=$2 AND role='player' AND parent_id<>$1", [r.claimed_by, r.player_id]).catch(console.error);
      }
    });
  }
  next();
}
queue.post("/point-requests/:id/approve", auth(["club", "admin"]), mustHoldClaim);
queue.post("/point-requests/:id/reject", auth(["club", "admin"]), mustHoldClaim);

// ---- Agent: where I receive money ----
queue.get("/club/channels", auth(["club"]), async (req, res) => {
  res.json((await pool.query("SELECT channel, phone, account_no FROM agent_channels WHERE user_id=$1 ORDER BY channel", [req.user!.id])).rows);
});

queue.put("/club/channels", auth(["club"]), async (req, res) => {
  const p = z.object({
    channel: z.enum(CHANNELS),
    phone: z.string().trim().regex(PHONE, "Enter a valid phone number"),
    account_no: z.string().trim().max(40).optional(),
  }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: p.error.issues[0].message }); return; }
  if (p.data.channel !== "Telebirr" && (p.data.account_no ?? "").length < 6) throw new HttpError(400, "Enter the " + p.data.channel + " account number");
  await pool.query(
    "INSERT INTO agent_channels (user_id, channel, phone, account_no) VALUES ($1,$2,$3,$4) " +
    "ON CONFLICT (user_id, channel) DO UPDATE SET phone=EXCLUDED.phone, account_no=EXCLUDED.account_no",
    [req.user!.id, p.data.channel, p.data.phone, p.data.account_no || null]
  );
  res.json({ ok: true });
});

// ---- Player: make a request ----
const common = {
  amount_minor: z.number().int().min(100, "The minimum is $1.00").max(100_000_000),
  channel: z.enum(CHANNELS),
  phone: z.string().trim().regex(PHONE, "Enter a valid phone number"),
  note: z.string().trim().max(200).optional(),
};

async function assertRoomForRequest(uid: number) {
  const n = (await pool.query("SELECT COUNT(*)::int AS v FROM point_requests WHERE player_id=$1 AND status='pending'", [uid])).rows[0].v as number;
  if (n >= MAX_OPEN) throw new HttpError(409, "You already have " + MAX_OPEN + " open requests. Wait for them to finish or cancel one.");
}

queue.post("/requests/deposit", auth(["player"]), async (req, res) => {
  const p = z.object(common).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: p.error.issues[0].message }); return; }
  const uid = req.user!.id;
  await assertRoomForRequest(uid);
  await assertCanDeposit(pool, uid, p.data.amount_minor, true);
  const parent = (await pool.query("SELECT parent_id FROM users WHERE id=$1", [uid])).rows[0].parent_id;
  const r = await pool.query(
    "INSERT INTO point_requests (player_id, club_id, type, amount_minor, channel, player_phone, player_note) VALUES ($1,$2,'deposit',$3,$4,$5,$6) RETURNING id",
    [uid, parent, p.data.amount_minor, p.data.channel, p.data.phone, p.data.note || null]
  );
  res.status(201).json({ id: r.rows[0].id });
});

queue.post("/requests/withdraw", auth(["player"]), async (req, res) => {
  const p = z.object({ ...common, account_no: z.string().trim().max(40).optional() }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: p.error.issues[0].message }); return; }
  if (p.data.channel !== "Telebirr" && (p.data.account_no ?? "").length < 6) throw new HttpError(400, "Enter your " + p.data.channel + " account number");
  const uid = req.user!.id;
  await assertRoomForRequest(uid);
  await assertCanWithdraw(pool, uid);
  const out = await requestWithdrawal(uid, p.data.amount_minor); // puts the amount on hold
  await pool.query(
    "UPDATE point_requests SET channel=$2, player_phone=$3, player_account=$4, player_note=$5 WHERE id=$1",
    [out.id, p.data.channel, p.data.phone, p.data.account_no || null, p.data.note || null]
  );
  res.status(201).json({ id: out.id });
});

queue.post("/requests/:id/reference", auth(["player"]), async (req, res) => {
  const p = z.object({ reference: z.string().trim().min(4, "Enter the transfer reference").max(60) }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: p.error.issues[0].message }); return; }
  const r = await pool.query(
    "UPDATE point_requests SET transfer_ref=$3 WHERE id=$1 AND player_id=$2 AND type='deposit' AND status='pending' AND claimed_by IS NOT NULL AND claim_expires_at > now() RETURNING id",
    [Number(req.params.id), req.user!.id, p.data.reference]
  );
  if (!r.rowCount) throw new HttpError(409, "You can add a reference once an agent has claimed your deposit");
  res.json({ ok: true });
});

queue.post("/requests/:id/cancel", auth(["player"]), async (req, res) => {
  const uid = req.user!.id;
  const out = await withTx(async (c) => {
    const r = (await c.query("SELECT * FROM point_requests WHERE id=$1 AND player_id=$2 FOR UPDATE", [Number(req.params.id), uid])).rows[0];
    if (!r) throw new HttpError(404, "Request not found");
    if (r.status !== "pending") throw new HttpError(409, "This request is already " + r.status);
    if (r.claimed_by && new Date(r.claim_expires_at) > new Date()) throw new HttpError(409, "An agent is already handling this request");
    if (r.type === "withdrawal") {
      const a = async (type: string) => (await c.query("SELECT id FROM accounts WHERE user_id=$1 AND type=$2", [uid, type])).rows[0].id as number;
      await post(c, {
        kind: "withdrawal_release", key: "wd-release:" + r.id, memo: "Withdrawal #" + r.id + " cancelled by player", createdBy: uid,
        entries: [{ accountId: await a("hold"), amount: -r.amount_minor }, { accountId: await a("credit"), amount: r.amount_minor }],
      });
    }
    await c.query("UPDATE point_requests SET status='cancelled', decided_at=now(), decided_by=$2 WHERE id=$1", [r.id, uid]);
    await c.query("INSERT INTO audit_logs (actor_id, action, entity, entity_id) VALUES ($1,'cancel_request','point_request',$2)", [uid, r.id]);
    return { id: r.id, status: "cancelled" };
  });
  res.json(out);
});

const LABEL: Record<string, string> = { approved: "COMPLETED", rejected: "REJECTED", cancelled: "CANCELLED", reversed: "REVERSED", expired: "EXPIRED" };

queue.get("/requests/mine", auth(["player"]), async (req, res) => {
  const rows = (await pool.query(
    "SELECT pr.id, pr.type, pr.amount_minor, pr.status, pr.channel, pr.player_phone, pr.player_account, pr.transfer_ref, pr.created_at, " +
    "pr.claimed_by, (pr.claim_expires_at > now()) AS live, pr.claim_expires_at, a.display_name AS agent_name, ac.phone AS agent_phone, ac.account_no AS agent_account " +
    "FROM point_requests pr LEFT JOIN users a ON a.id=pr.claimed_by LEFT JOIN agent_channels ac ON ac.user_id=pr.claimed_by AND ac.channel=pr.channel " +
    "WHERE pr.player_id=$1 ORDER BY pr.id DESC LIMIT 30",
    [req.user!.id]
  )).rows;
  res.json(rows.map((r) => {
    const showAgent = r.claimed_by && (r.status !== "pending" || r.live);
    return {
      id: r.id, type: r.type, amount_minor: r.amount_minor, channel: r.channel,
      your_phone: r.player_phone, your_account: r.player_account, transfer_ref: r.transfer_ref, created_at: r.created_at,
      status: r.status === "pending" ? (r.live && r.claimed_by ? "CLAIMED" : "OPEN") : (LABEL[r.status] ?? String(r.status).toUpperCase()),
      can_cancel: r.status === "pending" && !(r.live && r.claimed_by),
      agent: showAgent ? { name: r.agent_name, phone: r.agent_phone, account_no: r.agent_account } : null,
    };
  }));
});

// ---- Agent: the shared pool and my claims ----
queue.get("/queue/pool", auth(["club", "admin"]), async (req, res) => {
  const requests = (await pool.query(
    "SELECT pr.id, pr.type, pr.amount_minor, pr.channel, pr.created_at, p.display_name AS player, p.id AS player_id " +
    "FROM point_requests pr JOIN users p ON p.id=pr.player_id " +
    "WHERE pr.status='pending' AND (pr.claimed_by IS NULL OR pr.claim_expires_at <= now()) ORDER BY pr.created_at ASC LIMIT 100"
  )).rows;
  const mine = (await pool.query("SELECT balance_minor AS v FROM accounts WHERE user_id=$1 AND type='credit'", [req.user!.id])).rows[0];
  res.json({ my_credit_minor: mine?.v ?? 0, requests });
});

queue.get("/queue/mine", auth(["club"]), async (req, res) => {
  res.json((await pool.query(
    "SELECT pr.id, pr.type, pr.amount_minor, pr.channel, pr.player_phone, pr.player_account, pr.player_note, pr.transfer_ref, pr.claim_expires_at, pr.created_at, " +
    "p.display_name AS player, p.id AS player_id FROM point_requests pr JOIN users p ON p.id=pr.player_id " +
    "WHERE pr.status='pending' AND pr.claimed_by=$1 AND pr.claim_expires_at > now() ORDER BY pr.claimed_at",
    [req.user!.id]
  )).rows);
});

queue.post("/queue/:id/claim", auth(["club"]), async (req, res) => {
  const me = req.user!.id;
  const out = await withTx(async (c) => {
    // The row lock means two agents pressing Claim at the same moment are served one after the other
    const r = (await c.query("SELECT * FROM point_requests WHERE id=$1 FOR UPDATE", [Number(req.params.id)])).rows[0];
    if (!r) throw new HttpError(404, "Request not found");
    if (r.status !== "pending") throw new HttpError(409, "This request is already " + r.status);
    if (r.claimed_by && new Date(r.claim_expires_at) > new Date()) {
      throw new HttpError(409, Number(r.claimed_by) === me ? "You already claimed this request" : "Another agent already claimed this request");
    }
    const held = (await c.query("SELECT COUNT(*)::int AS v FROM point_requests WHERE status='pending' AND claimed_by=$1 AND claim_expires_at > now()", [me])).rows[0].v as number;
    if (held >= MAX_CLAIMS) throw new HttpError(409, "You are holding " + MAX_CLAIMS + " claims already. Finish or release one first.");
    if (r.type === "deposit") {
      const bal = (await c.query("SELECT balance_minor AS v FROM accounts WHERE user_id=$1 AND type='credit'", [me])).rows[0]?.v ?? 0;
      if (bal < r.amount_minor) throw new HttpError(409, "Your credit balance is too low to cover this deposit");
      if (r.channel) {
        const ch = await c.query("SELECT 1 FROM agent_channels WHERE user_id=$1 AND channel=$2", [me, r.channel]);
        if (!ch.rowCount) throw new HttpError(409, "Add your " + r.channel + " account details under Payment Accounts before claiming this");
      }
    }
    await c.query(
      "UPDATE point_requests SET claimed_by=$2, claimed_at=now(), claim_expires_at=now() + ($3 || ' minutes')::interval, club_id=$2 WHERE id=$1",
      [r.id, me, String(claimMinutes())]
    );
    await c.query("INSERT INTO audit_logs (actor_id, action, entity, entity_id, detail) VALUES ($1,'claim_request','point_request',$2,$3)", [me, r.id, JSON.stringify({ type: r.type, amount_minor: r.amount_minor })]);
    return { id: r.id, minutes: claimMinutes() };
  });
  res.json(out);
});

queue.post("/queue/:id/release", auth(["club"]), async (req, res) => {
  const r = await pool.query(
    "UPDATE point_requests SET claimed_by=NULL, claimed_at=NULL, claim_expires_at=NULL, club_id=(SELECT parent_id FROM users WHERE id=point_requests.player_id) " +
    "WHERE id=$1 AND status='pending' AND claimed_by=$2 RETURNING id",
    [Number(req.params.id), req.user!.id]
  );
  if (!r.rowCount) throw new HttpError(404, "You are not holding that request");
  await audit(req.user!.id, "release_claim", r.rows[0].id);
  res.json({ id: r.rows[0].id });
});