ALTER TABLE users ADD COLUMN date_of_birth DATE;
ALTER TABLE users ADD COLUMN kyc_status TEXT NOT NULL DEFAULT 'none' CHECK (kyc_status IN ('none','verified','rejected'));
ALTER TABLE users ADD COLUMN kyc_verified_by BIGINT REFERENCES users(id);
ALTER TABLE users ADD COLUMN kyc_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN kyc_note TEXT;
ALTER TABLE users ADD COLUMN excluded_until TIMESTAMPTZ;

CREATE TABLE player_limits (
  user_id BIGINT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('deposit_day','deposit_week','deposit_month','loss_day')),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  pending_amount_minor BIGINT,
  pending_from TIMESTAMPTZ,
  PRIMARY KEY (user_id, kind)
);