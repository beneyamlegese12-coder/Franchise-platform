CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('admin','super','club','player')),
  parent_id BIGINT REFERENCES users(id),
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen','banned')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX users_parent_idx ON users(parent_id);

CREATE TABLE accounts (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('credit','commission','mint','pool')),
  balance_minor BIGINT NOT NULL DEFAULT 0,
  UNIQUE (user_id, type),
  CONSTRAINT no_negative CHECK (type IN ('mint','pool') OR balance_minor >= 0)
);

CREATE TABLE ledger_transactions (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  memo TEXT,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
  id BIGSERIAL PRIMARY KEY,
  transaction_id BIGINT NOT NULL REFERENCES ledger_transactions(id),
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  amount_minor BIGINT NOT NULL,
  balance_after_minor BIGINT NOT NULL
);
CREATE INDEX ledger_entries_tx_idx ON ledger_entries(transaction_id);
CREATE INDEX ledger_entries_acct_idx ON ledger_entries(account_id);

CREATE FUNCTION check_tx_balanced() RETURNS trigger AS $$
DECLARE s BIGINT;
BEGIN
  SELECT COALESCE(SUM(amount_minor),0) INTO s FROM ledger_entries WHERE transaction_id = NEW.transaction_id;
  IF s <> 0 THEN
    RAISE EXCEPTION 'Ledger transaction % is not balanced (sum %)', NEW.transaction_id, s;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_tx_balanced();

CREATE FUNCTION block_ledger_changes() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Ledger rows are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION block_ledger_changes();
CREATE TRIGGER transactions_append_only BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION block_ledger_changes();

CREATE TABLE commission_rates (
  user_id BIGINT NOT NULL REFERENCES users(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('deposit','withdrawal')),
  rate_bps INT NOT NULL CHECK (rate_bps >= 0),
  cap_bps INT NOT NULL CHECK (cap_bps >= 0),
  PRIMARY KEY (user_id, event_type),
  CHECK (rate_bps <= cap_bps)
);

CREATE TABLE point_requests (
  id BIGSERIAL PRIMARY KEY,
  player_id BIGINT NOT NULL REFERENCES users(id),
  club_id BIGINT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('deposit','withdrawal')),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  decided_by BIGINT REFERENCES users(id)
);

CREATE TABLE credit_requests (
  id BIGSERIAL PRIMARY KEY,
  requester_id BIGINT NOT NULL REFERENCES users(id),
  approver_id BIGINT NOT NULL REFERENCES users(id),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);

CREATE TABLE commission_records (
  id BIGSERIAL PRIMARY KEY,
  source_transaction_id BIGINT REFERENCES ledger_transactions(id),
  point_request_id BIGINT REFERENCES point_requests(id),
  beneficiary_user_id BIGINT NOT NULL REFERENCES users(id),
  level TEXT NOT NULL CHECK (level IN ('club','super','admin')),
  event_type TEXT NOT NULL CHECK (event_type IN ('deposit','withdrawal')),
  base_amount_minor BIGINT NOT NULL,
  rate_bps INT NOT NULL,
  amount_minor BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'accrued' CHECK (status IN ('accrued','settled','reversed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX commission_records_benef_idx ON commission_records(beneficiary_user_id);

CREATE TABLE bets (
  id BIGSERIAL PRIMARY KEY,
  player_id BIGINT NOT NULL REFERENCES users(id),
  provider_tx_id TEXT NOT NULL UNIQUE,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  win_minor BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'settled' CHECK (status IN ('open','settled','voided','rolled_back')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_id BIGINT REFERENCES users(id),
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id BIGINT,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);