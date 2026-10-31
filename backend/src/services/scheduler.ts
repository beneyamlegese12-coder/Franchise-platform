import { runSettlement } from "./settlement.js";

// Off unless SETTLEMENT_AUTO=true. Runs once per day after SETTLEMENT_HOUR_UTC.
export function startScheduler() {
  if (process.env.SETTLEMENT_AUTO !== "true") {
    console.log("Daily settlement scheduler: off (set SETTLEMENT_AUTO=true in .env to enable)");
    return;
  }
  const hour = Number(process.env.SETTLEMENT_HOUR_UTC ?? 21);
  console.log("Daily settlement scheduler: on, runs after " + hour + ":00 UTC");
  setInterval(async () => {
    if (new Date().getUTCHours() < hour) return;
    try {
      const r = await runSettlement("auto", null);
      if (r) console.log("Settlement run #" + r.runId + ": " + r.total_minor + " minor units to " + r.users + " agents");
    } catch (e) {
      console.error("Settlement failed", e);
    }
  }, 60_000);
}