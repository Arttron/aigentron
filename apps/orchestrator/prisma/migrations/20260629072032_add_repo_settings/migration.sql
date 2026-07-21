-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN     "githubToken" TEXT,
ADD COLUMN     "repoBranch" TEXT NOT NULL DEFAULT 'main',
ADD COLUMN     "repoUrl" TEXT;
