ALTER TABLE point_requests DROP CONSTRAINT IF EXISTS point_requests_status_check;
ALTER TABLE point_requests ADD CONSTRAINT point_requests_status_check
  CHECK (status IN ('pending','approved','rejected','expired','reversed'));

CREATE TABLE settlement_runs (
  id BIGSERIAL PRIMARY KEY,
  run_date DATE NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('auto','manual')),
  total_minor BIGINT NOT NULL DEFAULT 0,
  users_count INT NOT NULL DEFAULT 0,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Only one automatic run per day, however many times the scheduler wakes up
CREATE UNIQUE INDEX settlement_auto_once ON settlement_runs (run_date) WHERE trigger = 'auto';

CREATE TABLE settlements (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES settlement_runs(id),
  user_id BIGINT NOT NULL REFERENCES users(id),
  total_minor BIGINT NOT NULL,
  ledger_transaction_id BIGINT NOT NULL REFERENCES ledger_transactions(id)
);

ALTER TABLE commission_records ADD COLUMN settlement_run_id BIGINT REFERENCES settlement_runs(id);