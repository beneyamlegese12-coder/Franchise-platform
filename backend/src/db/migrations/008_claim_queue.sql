ALTER TABLE point_requests
  ADD COLUMN claimed_by BIGINT REFERENCES users(id),
  ADD COLUMN claimed_at TIMESTAMPTZ,
  ADD COLUMN claim_expires_at TIMESTAMPTZ,
  ADD COLUMN channel TEXT CHECK (channel IN ('CBE','Telebirr','Bank')),
  ADD COLUMN player_phone TEXT,
  ADD COLUMN player_account TEXT,
  ADD COLUMN player_note TEXT,
  ADD COLUMN transfer_ref TEXT;

ALTER TABLE point_requests DROP CONSTRAINT IF EXISTS point_requests_status_check;
ALTER TABLE point_requests ADD CONSTRAINT point_requests_status_check
  CHECK (status IN ('pending','approved','rejected','expired','reversed','cancelled'));

CREATE INDEX point_requests_pool_idx ON point_requests (status, claimed_by);

-- Where an agent receives money from players
CREATE TABLE agent_channels (
  user_id BIGINT NOT NULL REFERENCES users(id),
  channel TEXT NOT NULL CHECK (channel IN ('CBE','Telebirr','Bank')),
  phone TEXT NOT NULL,
  account_no TEXT,
  PRIMARY KEY (user_id, channel)
);