ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_type_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_type_check
  CHECK (type IN ('credit','commission','mint','pool','hold','house'));

-- The house account holds game money, so it may go negative when wins exceed bets
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS no_negative;
ALTER TABLE accounts ADD CONSTRAINT no_negative
  CHECK (type IN ('mint','pool','house') OR balance_minor >= 0);

INSERT INTO accounts (user_id, type)
  SELECT id, 'house' FROM users WHERE role = 'admin'
  ON CONFLICT DO NOTHING;

ALTER TABLE bets ADD COLUMN IF NOT EXISTS game_id TEXT;
ALTER TABLE bets ADD COLUMN IF NOT EXISTS win_tx_id TEXT;