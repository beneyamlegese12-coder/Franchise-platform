import "dotenv/config";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { pool } from "./db/pool.js";
import { HttpError } from "./errors.js";
import { queue } from "./routes/queue.js";
import { points } from "./routes/points.js";
import { startScheduler } from "./services/scheduler.js";
import { security } from "./routes/security.js";
import { rg } from "./routes/rg.js";
import { withdrawals } from "./routes/withdrawals.js";
import { player } from "./routes/player.js";
import { lobby } from "./routes/lobby.js";
import { api } from "./routes/api.js";
import { credit } from "./routes/credit.js";
import { club } from "./routes/club.js";
import { admin } from "./routes/admin.js";
import { money } from "./routes/money.js";
import { games } from "./routes/games.js";
import { wallet } from "./routes/wallet.js";

if ((process.env.JWT_SECRET ?? "").length < 32) {
  console.error("JWT_SECRET must be at least 32 characters. Edit backend\\.env and restart.");
  process.exit(1);
}
if (!/^[0-9a-f]{64}$/i.test(process.env.ENCRYPTION_KEY ?? "")) {
  console.error("ENCRYPTION_KEY must be 64 hex characters. Edit backend\\.env and restart.");
  process.exit(1);
}

const app = express();
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || "http://localhost:5173" }));
app.use(express.json({ limit: "100kb", verify: (req: any, _res: any, buf: Buffer) => { req.rawBody = buf; } }));
app.use(morgan("dev"));

// Writes that move money are limited per client, on top of the login limit
const moneyLimiter = rateLimit({ windowMs: 60_000, limit: 60, skip: (req) => req.method === "GET" });
for (const p of ["/api/v1/point-requests", "/api/v1/withdrawals", "/api/v1/credit-requests", "/api/v1/admin/mint", "/api/v1/admin/reversals", "/api/v1/admin/settle"]) {
  app.use(p, moneyLimiter);
}

app.get("/api/v1/health", async (_req, res) => {
  try {
    const r = await pool.query("select now() as time");
    res.json({ status: "ok", dbTime: r.rows[0].time });
  } catch (e) {
    console.error(e);
    res.status(500).json({ status: "database unreachable" });
  }
});

app.use("/api/v1", queue);
app.use("/api/v1", points);
app.use("/api/v1", security);
app.use("/api/v1", rg);
app.use("/api/v1", withdrawals);
app.use("/api/v1", player);
app.use("/api/v1", lobby);
app.use("/api/v1", api);
app.use("/api/v1", credit);
app.use("/api/v1", club);
app.use("/api/v1", admin);
app.use("/api/v1", money);
app.use("/api/v1", games);
app.use("/api/v1", wallet);

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
  if (err?.code === "23514") { res.status(409).json({ error: "Not enough balance for this operation" }); return; }
  console.error(err);
  res.status(500).json({ error: "Server error" });
});

startScheduler();
const port = Number(process.env.PORT) || 4000;
app.listen(port, () => console.log("API running on http://localhost:" + port));