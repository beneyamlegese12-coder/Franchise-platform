import { Router } from "express";
import { randomInt, randomUUID } from "node:crypto";
import { z } from "zod";
import { pool, withTx } from "../db/pool.js";
import { auth } from "../auth.js";
import { post } from "../services/ledger.js";
import { assertCanPlay } from "../services/rg.js";
import { HttpError } from "../errors.js";

export const lobby = Router();

const demoOn = () => process.env.ENABLE_DEMO_GAMES === "true";

// The responsible-gambling checks use short codes for the game provider. Players get plain sentences.
const PLAIN: Record<string, string> = {
  player_excluded: "You have excluded yourself, so you cannot play until your break ends.",
  kyc_required: "Your identity has not been verified yet. Please ask your club agent to verify you.",
  loss_limit_reached: "This would go over your daily loss limit.",
};
async function plain<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HttpError && PLAIN[e.message]) throw new HttpError(e.status, PLAIN[e.message]);
    throw e;
  }
}

lobby.get("/games", async (_req, res) => {
  const r = await pool.query(
    "SELECT id, slug, title, category, provider, gateway, rtp_bps, volatility, theme FROM games WHERE active ORDER BY sort_order, id"
  );
  res.json(r.rows);
});

// Checks the player may play. With a real provider this is where the game URL would come from.
lobby.post("/games/:id/launch", auth(["player"]), async (req, res) => {
  const g = (await pool.query("SELECT id, title FROM games WHERE id=$1 AND active", [Number(req.params.id)])).rows[0];
  if (!g) throw new HttpError(404, "Game not found");
  await plain(() => assertCanPlay(pool, req.user!.id, 0));
  res.json({ game_id: g.id, title: g.title, demo: demoOn(), launch_url: null });
});

// Chance of a win by volatility, in basis points. Prize = stake x RTP / chance, so the long-run return equals the game's RTP.
const WIN_CHANCE: Record<string, number> = { Low: 6000, Medium: 4000, High: 2000 };

lobby.post("/games/:id/demo-round", auth(["player"]), async (req, res) => {
  if (!demoOn()) throw new HttpError(503, "Demo play is turned off. A game provider is not connected yet.");
  const p = z.object({ amount_minor: z.number().int().min(100).max(10_000_000) }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "Stake must be between $1.00 and $100,000.00" }); return; }
  const stake = p.data.amount_minor;
  const uid = req.user!.id;

  const out = await plain(() => withTx(async (c) => {
    const g = (await c.query("SELECT id, slug, rtp_bps, volatility FROM games WHERE id=$1 AND active", [Number(req.params.id)])).rows[0];
    if (!g) throw new HttpError(404, "Game not found");
    await assertCanPlay(c, uid, stake);

    const house = (await c.query("SELECT a.id FROM accounts a JOIN users u ON u.id=a.user_id WHERE u.role='admin' AND a.type='house' LIMIT 1")).rows[0]?.id;
    const credit = (await c.query("SELECT id FROM accounts WHERE user_id=$1 AND type='credit'", [uid])).rows[0]?.id;
    if (!house || !credit) throw new HttpError(500, "Wallet is not set up");

    const betId = "demo-bet-" + randomUUID();
    const winId = "demo-win-" + randomUUID();
    await c.query("INSERT INTO bets (player_id, provider_tx_id, amount_minor, status, game_id) VALUES ($1,$2,$3,'open',$4)", [uid, betId, stake, g.slug]);
    await post(c, { kind: "bet", key: "bet:" + betId, memo: "Demo bet " + g.slug, createdBy: uid,
      entries: [{ accountId: credit, amount: -stake }, { accountId: house, amount: stake }] });

    const chance = WIN_CHANCE[g.volatility];
    const win = randomInt(0, 10000) < chance ? Math.floor((stake * g.rtp_bps) / chance) : 0;
    if (win > 0) {
      await post(c, { kind: "win", key: "win:" + winId, memo: "Demo win " + g.slug, createdBy: uid,
        entries: [{ accountId: house, amount: -win }, { accountId: credit, amount: win }] });
    }
    await c.query("UPDATE bets SET status='settled', win_minor=$2, win_tx_id=$3 WHERE provider_tx_id=$1", [betId, win, winId]);
    const bal = (await c.query("SELECT balance_minor AS v FROM accounts WHERE id=$1", [credit])).rows[0].v as number;
    return { bet_minor: stake, win_minor: win, balance_minor: bal, result: win > 0 ? "win" : "loss" };
  }));
  res.json(out);
});