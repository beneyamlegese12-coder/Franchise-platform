ALTER TABLE users ADD COLUMN phone TEXT;
CREATE UNIQUE INDEX users_phone_unique ON users (phone) WHERE phone IS NOT NULL;
-- Existing accounts get a number built from their id, e.g. user 5 becomes +251900000005
UPDATE users SET phone = '+2519' || lpad(id::text, 8, '0') WHERE phone IS NULL;