-- A decision's public plan (the action alone) next to the owner's full plan, and what only the
-- owner may read: the facts the review saw. The enclave-signed risk-board record and its
-- signature are kept so anyone can check the public record against the enclave key.

ALTER TABLE decisions ADD COLUMN IF NOT EXISTS public_plan TEXT;
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS facts JSONB;
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS decision_json TEXT;
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS decision_signature TEXT;
