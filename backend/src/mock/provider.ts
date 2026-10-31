import "dotenv/config";
import { createHmac, randomUUID } from "node:crypto";

const base = "http://localhost:" + (process.env.PORT || 4000) + "/api/v1";
const secret = process.env.AGGREGATOR_SECRET as string;
if (!secret) { console.error("AGGREGATOR_SECRET is missing in .env"); process.exit(1); }

async function call(path: string, body: object, badSignature = false) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", badSignature ? "wrong-secret" : secret).update(ts + "." + raw).digest("hex");
  const r = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-timestamp": ts, "x-signature": sig },
    body: raw,
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
}

const rounds = Number(process.argv[2] ?? 30);
const players = ["player1", "player2", "player3", "player4"];
const gamesList = ["slots-lucky7", "roulette", "blackjack"];
const stat = { bets: 0, wins: 0, losses: 0, skipped: 0, duplicates: 0, rollbacks: 0, refused: 0 };
const cents = (n: number) => "$" + (n / 100).toFixed(2);

for (let i = 0; i < rounds; i++) {
  const player = players[Math.floor(Math.random() * players.length)];
  const bal = (await call("/wallet/balance", { player })).body.balance_minor ?? 0;
  if (bal < 100) { stat.skipped++; continue; }

  const amount = Math.max(100, Math.floor(Math.random() * Math.min(5000, bal)));
  const betId = "mock-bet-" + randomUUID();
  const bet = await call("/wallet/bet", { player, tx_id: betId, amount_minor: amount, game_id: gamesList[i % 3] });
  if (bet.status !== 200) { stat.refused++; console.log("bet refused:", bet.status, bet.body.error); continue; }
  stat.bets++;

  if (Math.random() < 0.05) {
    const again = await call("/wallet/bet", { player, tx_id: betId, amount_minor: amount });
    if (again.body.duplicate) stat.duplicates++;
  }

  // About 40% of rounds win 2.4x, so the theoretical return to player is 96%
  const win = Math.random() < 0.4 ? Math.round(amount * 2.4) : 0;
  const res = await call("/wallet/win", { player, tx_id: "mock-win-" + randomUUID(), bet_tx_id: betId, win_minor: win });
  if (res.status !== 200) { stat.refused++; console.log("win refused:", res.status, res.body.error); continue; }
  win > 0 ? stat.wins++ : stat.losses++;

  if (Math.random() < 0.03) {
    const rb = await call("/wallet/rollback", { player, bet_tx_id: betId });
    if (rb.status === 200) stat.rollbacks++; else console.log("rollback refused:", rb.status, rb.body.error);
  }
}

const bad = await call("/wallet/balance", { player: "player1" }, true);
console.log("Bad signature test:", bad.status, bad.body.error, bad.status === 401 ? "(correctly refused)" : "(PROBLEM)");
console.log("Played " + rounds + " rounds:", stat);