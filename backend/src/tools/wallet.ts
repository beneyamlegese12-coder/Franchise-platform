import "dotenv/config";
import { createHmac } from "node:crypto";

// Usage: npm run wallet -- bet player=alice tx_id=abc amount_minor=500
const [action, ...pairs] = process.argv.slice(2);
if (!action || !["balance", "bet", "win", "rollback"].includes(action)) {
  console.error("Usage: npm run wallet -- <balance|bet|win|rollback> key=value ...");
  process.exit(1);
}
const body: Record<string, string | number> = {};
for (const p of pairs) {
  const i = p.indexOf("=");
  const k = p.slice(0, i), v = p.slice(i + 1);
  body[k] = k.endsWith("_minor") ? Number(v) : v;
}
const raw = JSON.stringify(body);
const ts = String(Math.floor(Date.now() / 1000));
const sig = createHmac("sha256", process.env.AGGREGATOR_SECRET as string).update(ts + "." + raw).digest("hex");
const r = await fetch("http://localhost:" + (process.env.PORT || 4000) + "/api/v1/wallet/" + action, {
  method: "POST",
  headers: { "content-type": "application/json", "x-timestamp": ts, "x-signature": sig },
  body: raw,
});
console.log(r.status, JSON.stringify(await r.json().catch(() => ({}))));