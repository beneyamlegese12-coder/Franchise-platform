CREATE TABLE providers (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  api_endpoint TEXT NOT NULL,
  fee_bps INT NOT NULL CHECK (fee_bps BETWEEN 0 AND 5000),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  latency_ms INT,
  last_ping_at TIMESTAMPTZ
);

-- Placeholder providers and fees. Replace with your real contracts.
INSERT INTO providers (code, name, category, api_endpoint, fee_bps) VALUES
 ('EVO',   'Evolution Gaming',     'Live Casino', 'https://api.aggregator.example/evolution', 1500),
 ('NEXUS', 'Aggregated Providers', 'Slots',       'https://api.aggregator.example/nexus',     500),
 ('NE',    'NetEnt',               'Table Games', 'https://api.aggregator.example/netent',    1200),
 ('SPB',   'Spribe',               'Crash Games', 'https://api.aggregator.example/spribe',    1000),
 ('PG',    'PG Soft',              'Slots',       'https://api.aggregator.example/pgsoft',    1200),
 ('PP',    'Pragmatic Play',       'Slots',       'https://api.aggregator.example/pragmatic', 1500),
 ('MIKA',  'Mika Games',           'Slots',       'https://api.aggregator.example/mika',      0);