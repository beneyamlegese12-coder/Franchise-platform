INSERT INTO accounts (user_id, type)
SELECT u.id, 'hold' FROM users u
WHERE u.role = 'player'
  AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.user_id = u.id AND a.type = 'hold');