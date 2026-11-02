-- The model that answers questions (provider/model); null = the agent's own.
ALTER TABLE "AppSettings" ADD COLUMN "askModel" TEXT;
