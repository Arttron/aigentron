-- CreateEnum
CREATE TYPE "AppMode" AS ENUM ('offline', 'online');

-- CreateTable
CREATE TABLE "AppSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "mode" "AppMode" NOT NULL DEFAULT 'online',
    "routineModel" TEXT NOT NULL,
    "routineBaseUrl" TEXT NOT NULL,
    "routineAuthToken" TEXT NOT NULL DEFAULT 'ollama',
    "complexModel" TEXT NOT NULL,
    "anthropicApiKey" TEXT,
    "complexBaseUrl" TEXT,
    "complexAuthToken" TEXT,
    "approvalTimeoutSeconds" INTEGER NOT NULL DEFAULT 300,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSettings_pkey" PRIMARY KEY ("id")
);
