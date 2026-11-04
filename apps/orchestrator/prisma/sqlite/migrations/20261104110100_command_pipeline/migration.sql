-- The command pipeline: how many heavy commands run at once (0 = automatic) and the switch.
ALTER TABLE "AppSettings" ADD COLUMN "heavySlots" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AppSettings" ADD COLUMN "commandPipeline" BOOLEAN NOT NULL DEFAULT true;
