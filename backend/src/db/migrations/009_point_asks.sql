CREATE TABLE point_asks (
  id BIGSERIAL PRIMARY KEY,
  requester_id BIGINT NOT NULL REFERENCES users(id),
  requester_role TEXT NOT NULL CHECK (requester_role IN ('club','super')),
  type TEXT NOT NULL CHECK (type IN ('deposit','withdrawal')),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  reference TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  claimed_by BIGINT REFERENCES users(id),
  claimed_at TIMESTAMPTZ,
  claim_expires_at TIMESTAMPTZ,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX point_asks_pool_idx ON point_asks (status, requester_role);
-- A transfer reference can only be used once
CREATE UNIQUE INDEX point_asks_ref_unique ON point_asks (lower(reference))
  WHERE reference IS NOT NULL AND status IN ('pending','approved');