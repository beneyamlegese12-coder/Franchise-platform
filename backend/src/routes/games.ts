import { Router } from "express";
import { pool } from "../db/pool.js";
import { auth } from "../auth.js";

export const games = Router();

games.get("/admin/games", auth(["admin"]), async (_req, res) => {
  const t = (await pool.query(
    "SELECT " +
    "COALESCE(SUM(amount_minor) FILTER (WHERE status='settled'),0)::bigint AS bets, " +
    "COALESCE(SUM(win_minor) FILTER (WHERE status='settled'),0)::bigint AS wins, " +
    "COUNT(*) FILTER (WHERE status='settled')::bigint AS settled, " +
    "COUNT(*) FILTER (WHERE status='open')::bigint AS open, " +
    "COUNT(*) FILTER (WHERE status='rolled_back')::bigint AS rolled_back FROM bets"
  )).rows[0];
  const house = (await pool.query(
    "SELECT COALESCE(SUM(balance_minor),0)::bigint AS v FROM accounts WHERE type='house'"
  )).rows[0].v as number;
  const recent = await pool.query(
    "SELECT b.id, p.display_name AS player, b.provider_tx_id, b.game_id, b.amount_minor, b.win_minor, b.status, b.created_at " +
    "FROM bets b JOIN users p ON p.id=b.player_id ORDER BY b.id DESC LIMIT 50"
  );
  res.json({
    bets_minor: t.bets, wins_minor: t.wins, ggr_minor: t.bets - t.wins,
    settled: t.settled, open: t.open, rolled_back: t.rolled_back,
    house_balance_minor: house, recent: recent.rows,
  });
});