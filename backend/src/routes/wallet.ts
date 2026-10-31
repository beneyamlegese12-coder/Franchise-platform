import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { PoolClient } from "pg";
import { withTx } from "../db/pool.js";
import { post } from "../services/ledger.js";
import { assertCanPlay } from "../services/rg.js";
import { HttpError } from "../errors.js";

export const wallet = Router();

// Every call must carry x-timestamp and x-signature = HMAC-SHA256(secret, timestamp + "." + rawBody)
function verify(req: Request, res: Response, next: NextFunction) {
  const secret = process.env.AGGREGATOR_SECRET;
  const raw: Buffer | undefined = (req as any).rawBody;
  if (!secret || !raw) { res.status(500).json({ error: "wallet_not_configured" }); return; }
  const ts = String(req.headers["x-timestamp"] ?? "");
  const sig = String(req.headers["x-signature"] ?? "");
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!ts || !Number.isFinite(age) || age > 300) { res.status(401).json({ error: "stale_or_missing_timestamp" }); return; }
  const expect = Buffer.from(createHmac("sha256", secret).update(ts + "." + raw.toString("utf8")).digest("hex"));
  const got = Buffer.from(sig);
  if (expect.length !== got.length || !timingSafeEqual(expect, got)) { res.status(401).json({ error: "bad_signature" }); return; }
  next();
}
wallet.use("/wallet", verify);

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    if (e?.code === "23514") throw new HttpError(402, "insufficient_funds");
    if (e?.code === "23505") throw new HttpError(409, "duplicate_in_flight");
    throw e;
  }
}

const acct = async (c: PoolClient, uid: number, type: string) => {
  const r = await c.query("SELECT id FROM accounts WHERE user_id=$1 AND type=$2", [uid, type]);
  if (!r.rowCount) throw new HttpError(500, "missing_account");
  return r.rows[0].id as number;
};
const houseAccount = async (c: PoolClient) => {
  const r = await c.query("SELECT a.id FROM accounts a JOIN users u ON u.id=a.user_id WHERE u.role='admin' AND a.type='house' LIMIT 1");
  if (!r.rowCount) throw new HttpError(500, "missing_house_account");
  return r.rows[0].id as number;
};
const balance = async (c: PoolClient, uid: number) =>
  (await c.query("SELECT balance_minor AS v FROM accounts WHERE user_id=$1 AND type='credit'", [uid])).rows[0].v as number;
const findPlayer = async (c: PoolClient, username: string) => {
  const r = await c.query("SELECT id, status FROM users WHERE username=$1 AND role='player'", [username]);
  if (!r.rowCount) throw new HttpError(404, "unknown_player");
  return r.rows[0] as { id: number; status: string };
};

wallet.post("/wallet/balance", async (req, res) => {
  const p = z.object({ player: z.string().min(1) }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "bad_request" }); return; }
  res.json(await withTx(async (c) => {
    const pl = await findPlayer(c, p.data.player);
    return { balance_minor: await balance(c, pl.id), status: pl.status };
  }));
});

wallet.post("/wallet/bet", async (req, res) => {
  const p = z.object({
    player: z.string().min(1),
    tx_id: z.string().min(1).max(100),
    amount_minor: z.number().int().positive().max(100_000_000),
    game_id: z.string().max(100).optional(),
  }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "bad_request" }); return; }
  const d = p.data;
  res.json(await guard(() => withTx(async (c) => {
    const pl = await findPlayer(c, d.player);
    const dup = await c.query("SELECT 1 FROM bets WHERE provider_tx_id=$1", [d.tx_id]);
    if (dup.rowCount) return { duplicate: true, balance_minor: await balance(c, pl.id) };
    if (pl.status !== "active") throw new HttpError(403, "player_blocked");
    await assertCanPlay(c, pl.id, d.amount_minor);
    await c.query(
      "INSERT INTO bets (player_id, provider_tx_id, amount_minor, status, game_id) VALUES ($1,$2,$3,'open',$4)",
      [pl.id, d.tx_id, d.amount_minor, d.game_id ?? null]
    );
    await post(c, {
      kind: "bet", key: "bet:" + d.tx_id, memo: "Bet " + d.tx_id, createdBy: pl.id,
      entries: [
        { accountId: await acct(c, pl.id, "credit"), amount: -d.amount_minor },
        { accountId: await houseAccount(c), amount: d.amount_minor },
      ],
    });
    return { duplicate: false, balance_minor: await balance(c, pl.id) };
  })));
});

// win_minor of 0 settles the bet as a loss
wallet.post("/wallet/win", async (req, res) => {
  const p = z.object({
    player: z.string().min(1),
    tx_id: z.string().min(1).max(100),
    bet_tx_id: z.string().min(1).max(100),
    win_minor: z.number().int().min(0).max(1_000_000_000),
  }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "bad_request" }); return; }
  const d = p.data;
  res.json(await guard(() => withTx(async (c) => {
    const pl = await findPlayer(c, d.player);
    const b = await c.query("SELECT * FROM bets WHERE provider_tx_id=$1 AND player_id=$2 FOR UPDATE", [d.bet_tx_id, pl.id]);
    if (!b.rowCount) throw new HttpError(404, "unknown_bet");
    const bet = b.rows[0];
    if (bet.win_tx_id === d.tx_id) return { duplicate: true, balance_minor: await balance(c, pl.id) };
    if (bet.status !== "open") throw new HttpError(409, "bet_not_open");
    if (d.win_minor > 0) {
      await post(c, {
        kind: "win", key: "win:" + d.tx_id, memo: "Win " + d.tx_id, createdBy: pl.id,
        entries: [
          { accountId: await houseAccount(c), amount: -d.win_minor },
          { accountId: await acct(c, pl.id, "credit"), amount: d.win_minor },
        ],
      });
    }
    await c.query("UPDATE bets SET status='settled', win_minor=$2, win_tx_id=$3 WHERE id=$1", [bet.id, d.win_minor, d.tx_id]);
    return { duplicate: false, balance_minor: await balance(c, pl.id) };
  })));
});

// Undoes a bet, and any win already paid on it
wallet.post("/wallet/rollback", async (req, res) => {
  const p = z.object({ player: z.string().min(1), bet_tx_id: z.string().min(1).max(100) }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "bad_request" }); return; }
  const d = p.data;
  res.json(await guard(() => withTx(async (c) => {
    const pl = await findPlayer(c, d.player);
    const b = await c.query("SELECT * FROM bets WHERE provider_tx_id=$1 AND player_id=$2 FOR UPDATE", [d.bet_tx_id, pl.id]);
    if (!b.rowCount) throw new HttpError(404, "unknown_bet");
    const bet = b.rows[0];
    if (bet.status === "rolled_back") return { duplicate: true, balance_minor: await balance(c, pl.id) };
    const net: number = bet.amount_minor - (bet.status === "settled" ? bet.win_minor : 0);
    if (net !== 0) {
      await post(c, {
        kind: "bet_rollback", key: "rollback:" + d.bet_tx_id, memo: "Rollback of bet " + d.bet_tx_id, createdBy: pl.id,
        entries: [
          { accountId: await acct(c, pl.id, "credit"), amount: net },
          { accountId: await houseAccount(c), amount: -net },
        ],
      });
    }
    await c.query("UPDATE bets SET status='rolled_back' WHERE id=$1", [bet.id]);
    return { duplicate: false, balance_minor: await balance(c, pl.id) };
  })));
});