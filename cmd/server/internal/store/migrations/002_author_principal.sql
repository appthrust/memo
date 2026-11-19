-- Preserve historical subjects for rollback; new authors store only the signed
-- principal. Open completes the issuer-dependent backfill before serving traffic.
ALTER TABLE authors ADD COLUMN principal text UNIQUE;
ALTER TABLE authors ALTER COLUMN subject DROP NOT NULL;
