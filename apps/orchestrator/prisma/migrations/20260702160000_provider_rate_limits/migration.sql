-- Optional per-provider rate caps (rpm/tpm) enforced by LiteLLM.
ALTER TABLE "Provider" ADD COLUMN "rpm" INTEGER;
ALTER TABLE "Provider" ADD COLUMN "tpm" INTEGER;
