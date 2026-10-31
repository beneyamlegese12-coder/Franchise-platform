import type { PoolClient } from "pg";

export type Entry = { accountId: number; amount: number };
export type PostInput = {
  kind: string;
  key: string;
  memo?: string;
  createdBy?: number | null;
  entries: Entry[];
};

// Posts one balanced, idempotent ledger transaction inside the caller's DB transaction.
export async function post(c: PoolClient, i: PostInput): Promise<{ id: number; duplicate: boolean }> {
  if (i.entries.some((e) => !Number.isInteger(e.amount) || e.amount === 0)) {
    throw new Error("Ledger entries must be non-zero whole numbers (minor units)");
  }
  if (i.entries.reduce((s, e) => s + e.amount, 0) !== 0) {
    throw new Error("Ledger transaction is not balanced");
  }

  const ins = await c.query(
    "INSERT INTO ledger_transactions (kind, idempotency_key, memo, created_by) VALUES ($1,$2,$3,$4) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id",
    [i.kind, i.key, i.memo ?? null, i.createdBy ?? null]
  );
  if (ins.rowCount === 0) {
    const ex = await c.query("SELECT id FROM ledger_transactions WHERE idempotency_key=$1", [i.key]);
    return { id: ex.rows[0].id, duplicate: true };
  }
  const id: number = ins.rows[0].id;

  // Lock accounts in a fixed order so two payments can never deadlock
  const ids = [...new Set(i.entries.map((e) => e.accountId))].sort((a, b) => a - b);
  await c.query("SELECT id FROM accounts WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE", [ids]);

  for (const e of i.entries) {
    const r = await c.query(
      "UPDATE accounts SET balance_minor = balance_minor + $1 WHERE id=$2 RETURNING balance_minor",
      [e.amount, e.accountId]
    );
    await c.query(
      "INSERT INTO ledger_entries (transaction_id, account_id, amount_minor, balance_after_minor) VALUES ($1,$2,$3,$4)",
      [id, e.accountId, e.amount, r.rows[0].balance_minor]
    );
  }
  return { id, duplicate: false };
}