CREATE TABLE games (
  id BIGSERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('Slots','Live Casino','Sportsbook','Crash Games','Table Games')),
  provider TEXT NOT NULL,
  gateway BOOLEAN NOT NULL DEFAULT false,
  rtp_bps INT NOT NULL CHECK (rtp_bps BETWEEN 5000 AND 10000),
  volatility TEXT NOT NULL CHECK (volatility IN ('Low','Medium','High')),
  theme TEXT NOT NULL DEFAULT 'violet',
  active BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0
);

-- Sample catalog. Replace with your real provider's games.
INSERT INTO games (slug, title, category, provider, gateway, rtp_bps, volatility, theme, sort_order) VALUES
 ('mika-majestic-fruits',   'Mika Majestic Fruits',     'Slots',       'Mika Games',          true,  9720, 'High',   'violet',  1),
 ('casino-royale-blackjack','Casino Royale Blackjack',  'Table Games', 'Aggregated Providers', true,  9910, 'Medium', 'green',   2),
 ('space-interstellar-crash','Space Interstellar Crash','Crash Games', 'Aggregated Providers', true,  9850, 'High',   'purple',  3),
 ('golden-fortune-spins',   'Golden Fortune Spins',     'Slots',       'Pragmatic Play',      false, 9650, 'High',   'orange',  4),
 ('midnight-roulette-live', 'Midnight Roulette Live',   'Live Casino', 'Pragmatic Play',      false, 9730, 'Medium', 'pink',    5),
 ('rocket-rush-crash',      'Rocket Rush Crash',        'Crash Games', 'Pragmatic Play',      false, 9700, 'High',   'magenta', 6),
 ('premier-match-odds',     'Premier Match Odds',       'Sportsbook',  'Aggregated Providers', true, 9500, 'Medium', 'blue',    7),
 ('dragon-pearl-slots',     'Dragon Pearl Slots',       'Slots',       'Mika Games',          true,  9680, 'Medium', 'red',     8),
 ('baccarat-gold-live',     'Baccarat Gold Live',       'Live Casino', 'Aggregated Providers', true, 9890, 'Low',    'teal',    9),
 ('neon-poker-table',       'Neon Poker Table',         'Table Games', 'Pragmatic Play',      false, 9820, 'Low',    'indigo', 10);