-- Provider gains an explicit upstream "kind" (LiteLLM backend family).
ALTER TABLE "Provider" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'openai';

-- Backfill existing rows from their base URL (best-effort; editable in the UI).
UPDATE "Provider" SET "kind" =
  CASE
    WHEN "baseUrl" IS NULL OR "baseUrl" = '' THEN 'anthropic'
    WHEN "baseUrl" ILIKE '%api.anthropic.com%' THEN 'anthropic'
    WHEN "baseUrl" ILIKE '%api.z.ai%' THEN 'anthropic'
    WHEN "baseUrl" ILIKE '%api.deepseek.com%' THEN 'deepseek'
    WHEN "baseUrl" ILIKE '%api.openai.com%' THEN 'openai'
    WHEN "baseUrl" ILIKE '%11434%' OR "baseUrl" ILIKE '%ollama%' THEN 'ollama'
    WHEN "baseUrl" ILIKE '%litellm%' THEN 'ollama'
    ELSE 'openai'
  END;
