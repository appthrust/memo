-- Preserve historical subjects for rollback; new authors store only the signed
-- principal. Legacy rows can be rekeyed at sign-in or by an optional issuer backfill.
ALTER TABLE authors ADD COLUMN principal text UNIQUE;
ALTER TABLE authors ALTER COLUMN subject DROP NOT NULL;
