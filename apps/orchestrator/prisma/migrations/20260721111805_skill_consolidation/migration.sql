-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN     "lastSkillConsolidationAt" TIMESTAMP(3),
ADD COLUMN     "skillConsolidationAgent" TEXT DEFAULT 'architect',
ADD COLUMN     "skillConsolidationIntervalDays" INTEGER NOT NULL DEFAULT 7;
