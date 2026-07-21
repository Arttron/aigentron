-- Drop legacy tier/mode config now that routing is provider-based.

-- AppSettings: remove tier-era model config
ALTER TABLE "AppSettings" DROP COLUMN IF EXISTS "mode";
ALTER TABLE "AppSettings" DROP COLUMN IF EXISTS "routineModel";
ALTER TABLE "AppSettings" DROP COLUMN IF EXISTS "routineBaseUrl";
ALTER TABLE "AppSettings" DROP COLUMN IF EXISTS "routineAuthToken";
ALTER TABLE "AppSettings" DROP COLUMN IF EXISTS "complexModel";
ALTER TABLE "AppSettings" DROP COLUMN IF EXISTS "anthropicApiKey";
ALTER TABLE "AppSettings" DROP COLUMN IF EXISTS "complexBaseUrl";
ALTER TABLE "AppSettings" DROP COLUMN IF EXISTS "complexAuthToken";

-- Task: remove tier
ALTER TABLE "Task" DROP COLUMN IF EXISTS "tier";
ALTER TABLE "Task" DROP COLUMN IF EXISTS "tierSource";

-- Drop now-unused enum types
DROP TYPE IF EXISTS "TaskTier";
DROP TYPE IF EXISTS "TierSource";
DROP TYPE IF EXISTS "AppMode";
DROP TYPE IF EXISTS "ModelProvider";
