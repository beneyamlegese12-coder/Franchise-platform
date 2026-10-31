import { HttpError } from "../errors.js";

type Q = { query(text: string, values?: any[]): Promise<{ rows: any[]; rowCount: number | null }> };

export const LIMIT_KINDS = ["deposit_day", "deposit_week", "deposit_month", "loss_day"] as const;
export const COOLING_HOURS = 24;
export const needKyc = () => process.env.REQUIRE_KYC === "true";
export const minAge = () => Number(process.env.MIN_AGE ?? 18);

const fmt = (m: number) => "$" + (m / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Limit changes that waited out their cooling-off period take effect here.
export async function applyMatured(q: Q, uid: number) {
  await q.query("DELETE FROM player_limits WHERE user_id=$1 AND pending_from <= now() AND pending_amount_minor = 0", [uid]);
  await q.query(
    "UPDATE player_limits SET amount_minor=pending_amount_minor, pending_amount_minor=NULL, pending_from=NULL " +
    "WHERE user_id=$1 AND pending_from <= now() AND pending_amount_minor > 0", [uid]
  );
}

export async function usage(q: Q, uid: number) {
  const d = (await q.query(
    "SELECT " +
    "COALESCE(SUM(amount_minor) FILTER (WHERE decided_at >= now() - interval '1 day'),0)::bigint AS d1, " +
    "COALESCE(SUM(amount_minor) FILTER (WHERE decided_at >= now() - interval '7 days'),0)::bigint AS d7, " +
    "COALESCE(SUM(amount_minor) FILTER (WHERE decided_at >= now() - interval '30 days'),0)::bigint AS d30 " +
    "FROM point_requests WHERE player_id=$1 AND type='deposit' AND status='approved'", [uid]
  )).rows[0];
  const pending = (await q.query(
    "SELECT COALESCE(SUM(amount_minor),0)::bigint AS v FROM point_requests WHERE player_id=$1 AND type='deposit' AND status='pending'", [uid]
  )).rows[0].v as number;
  const loss = (await q.query(
    "SELECT GREATEST(0, COALESCE(SUM(CASE WHEN status='settled' THEN amount_minor - win_minor WHEN status='open' THEN amount_minor ELSE 0 END),0))::bigint AS v " +
    "FROM bets WHERE player_id=$1 AND created_at >= now() - interval '1 day'", [uid]
  )).rows[0].v as number;
  return { d1: d.d1 as number, d7: d.d7 as number, d30: d.d30 as number, pending, loss };
}

async function who(q: Q, uid: number) {
  const u = (await q.query("SELECT kyc_status, excluded_until FROM users WHERE id=$1", [uid])).rows[0];
  if (!u) throw new HttpError(404, "Player not found");
  return u as { kyc_status: string; excluded_until: string | null };
}
const isExcluded = (u: { excluded_until: string | null }) => !!u.excluded_until && new Date(u.excluded_until) > new Date();

export async function assertCanWithdraw(q: Q, uid: number) {
  const u = await who(q, uid);
  if (needKyc() && u.kyc_status !== "verified") throw new HttpError(403, "Your identity has not been verified yet. Please ask your club agent to verify you.");
}

// includePending: when a player creates a request, requests still waiting also count toward the limit.
export async function assertCanDeposit(q: Q, uid: number, amount: number, includePending: boolean) {
  const u = await who(q, uid);
  if (isExcluded(u)) throw new HttpError(403, "You have excluded yourself until " + new Date(u.excluded_until!).toLocaleDateString() + ". Deposits are not possible until then.");
  if (needKyc() && u.kyc_status !== "verified") throw new HttpError(403, "Your identity has not been verified yet. Please ask your club agent to verify you.");
  await applyMatured(q, uid);
  const limits = (await q.query("SELECT kind, amount_minor FROM player_limits WHERE user_id=$1", [uid])).rows;
  if (!limits.length) return;
  const use = await usage(q, uid);
  const extra = includePending ? use.pending : 0;
  const used: Record<string, number> = { deposit_day: use.d1 + extra, deposit_week: use.d7 + extra, deposit_month: use.d30 + extra };
  const names: Record<string, string> = { deposit_day: "daily", deposit_week: "weekly", deposit_month: "monthly" };
  for (const l of limits) {
    if (!(l.kind in used)) continue;
    if (used[l.kind] + amount > l.amount_minor) {
      const left = Math.max(0, l.amount_minor - used[l.kind]);
      throw new HttpError(409, "This would go over your " + names[l.kind] + " deposit limit of " + fmt(l.amount_minor) + ". You can deposit up to " + fmt(left) + " more.");
    }
  }
}

// Provider-facing, so the errors are stable codes rather than sentences.
export async function assertCanPlay(q: Q, uid: number, stake: number) {
  const u = await who(q, uid);
  if (isExcluded(u)) throw new HttpError(403, "player_excluded");
  if (needKyc() && u.kyc_status !== "verified") throw new HttpError(403, "kyc_required");
  await applyMatured(q, uid);
  const lim = (await q.query("SELECT amount_minor FROM player_limits WHERE user_id=$1 AND kind='loss_day'", [uid])).rows[0];
  if (!lim) return;
  const use = await usage(q, uid);
  if (use.loss + stake > lim.amount_minor) throw new HttpError(403, "loss_limit_reached");
}