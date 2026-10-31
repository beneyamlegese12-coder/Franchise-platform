import bcrypt from "bcryptjs";
import { pool, withTx } from "./pool.js";
import { post } from "../services/ledger.js";

const PASS = "Demo#2026pass"; // demo only, change before any real use

await withTx(async (c) => {
  const n = await c.query("SELECT COUNT(*)::bigint AS n FROM users");
  if (n.rows[0].n > 0) { console.log("Already seeded. Nothing to do."); return; }

  const hash = await bcrypt.hash(PASS, 10);
  const mk = async (role: string, parent: number | null, username: string, name: string) =>
    (await c.query(
      "INSERT INTO users (role, parent_id, username, display_name, password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [role, parent, username, name, hash]
    )).rows[0].id as number;
  const acct = async (uid: number, type: string) =>
    (await c.query("INSERT INTO accounts (user_id, type) VALUES ($1,$2) RETURNING id", [uid, type])).rows[0].id as number;

  const admin = await mk("admin", null, "nexus_admin", "Nexus Global Admin");
  const sup = await mk("super", admin, "vortex_elite", "Vortex Elite Distribution");
  const alpha = await mk("club", sup, "club_alpha", "Club Alpha");
  const bravo = await mk("club", sup, "club_bravo", "Club Bravo");
  const p1 = await mk("player", alpha, "player1", "Player 1");
  const p2 = await mk("player", alpha, "player2", "Player 2");
  const p3 = await mk("player", bravo, "player3", "Player 3");
  const p4 = await mk("player", bravo, "player4", "Player 4");

  const mint = await acct(admin, "mint");
  await acct(admin, "pool");
  await acct(admin, "credit");
  await acct(admin, "commission");
  const supCredit = await acct(sup, "credit");
  await acct(sup, "commission");
  const alphaCredit = await acct(alpha, "credit");
  await acct(alpha, "commission");
  const bravoCredit = await acct(bravo, "credit");
  await acct(bravo, "commission");
  for (const p of [p1, p2, p3, p4]) await acct(p, "credit");

  // Deposit rates (basis points): club 5%, super 2%, admin 1%
  for (const [uid, bps] of [[alpha, 500], [bravo, 500], [sup, 200], [admin, 100]]) {
    await c.query("INSERT INTO commission_rates (user_id, event_type, rate_bps, cap_bps) VALUES ($1,'deposit',$2,$2)", [uid, bps]);
  }

  // Mint 500,000.00 to the super agent, then fund the two clubs
  await post(c, { kind: "mint", key: "seed:mint", memo: "Initial credits", createdBy: admin,
    entries: [{ accountId: mint, amount: -50000000 }, { accountId: supCredit, amount: 50000000 }] });
  await post(c, { kind: "transfer", key: "seed:fund-alpha", memo: "Fund Club Alpha", createdBy: sup,
    entries: [{ accountId: supCredit, amount: -1000000 }, { accountId: alphaCredit, amount: 1000000 }] });
  await post(c, { kind: "transfer", key: "seed:fund-bravo", memo: "Fund Club Bravo", createdBy: sup,
    entries: [{ accountId: supCredit, amount: -500000 }, { accountId: bravoCredit, amount: 500000 }] });

  // Sample bets (total 15,000.00) and two pending deposit requests
  const bets: [number, number][] = [[p1, 600000], [p2, 300000], [p3, 400000], [p4, 200000]];
  let k = 1;
  for (const [pid, amt] of bets) {
    await c.query("INSERT INTO bets (player_id, provider_tx_id, amount_minor) VALUES ($1,$2,$3)", [pid, "seed-bet-" + k++, amt]);
  }
  await c.query("INSERT INTO point_requests (player_id, club_id, type, amount_minor) VALUES ($1,$2,'deposit',200000)", [p1, alpha]);
  await c.query("INSERT INTO point_requests (player_id, club_id, type, amount_minor) VALUES ($1,$2,'deposit',100000)", [p2, alpha]);

  console.log("Seeded. Demo password for every user: " + PASS);
});
await pool.end();