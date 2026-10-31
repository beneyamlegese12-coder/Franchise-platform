ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_type_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_type_check
  CHECK (type IN ('credit','commission','mint','pool','hold'));

INSERT INTO accounts (user_id, type)
  SELECT id, 'hold' FROM users WHERE role = 'player'
  ON CONFLICT DO NOTHING;

-- Placeholder withdrawal rates in basis points: club 1%, super 0.5%, admin 0.25%
INSERT INTO commission_rates (user_id, event_type, rate_bps, cap_bps)
  SELECT u.id, 'withdrawal', v.bps, v.bps
  FROM users u
  JOIN (VALUES ('club_alpha',100),('club_bravo',100),('vortex_elite',50),('nexus_admin',25)) AS v(username, bps)
    ON v.username = u.username
  ON CONFLICT DO NOTHING;