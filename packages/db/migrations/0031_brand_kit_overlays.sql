-- 0031_brand_kit_overlays
-- Adds tagline and agent_name to brand_kits for use in rendered overlay frames
-- (intro/outro splash, lower-third label). Both columns are nullable so existing
-- kits keep working without any value. Seeded for the 4 live kits below.

ALTER TABLE brand_kits ADD COLUMN tagline text;
ALTER TABLE brand_kits ADD COLUMN agent_name text;

-- Seed the 4 existing kits for tenant 8b97e0ad-523b-487f-9c68-b416e070fe04
UPDATE brand_kits SET tagline = 'Powered by Keller Williams', agent_name = 'KW Brokerage'
  WHERE id = '540163e6-e7f1-4800-8656-b18f11ad8bcc';

UPDATE brand_kits SET tagline = 'Your Home Awaits', agent_name = 'Amy Casanova'
  WHERE id = '486649b8-0dc4-4f3e-98f1-5b410a6ec490';

UPDATE brand_kits SET tagline = 'Smart Investing in Mohave County', agent_name = 'Justin Casanova'
  WHERE id = '170a3a12-3e84-4ede-942e-58e9fa026f70';

UPDATE brand_kits SET tagline = 'Real Estate. Done Right.', agent_name = 'Novacor'
  WHERE id = 'f311c2c1-a771-4e26-9304-e2ee0b6478d2';
