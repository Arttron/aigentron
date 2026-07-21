-- CreateTable
CREATE TABLE "ManagedLitellmRoute" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "backend" TEXT NOT NULL,
    "apiBase" TEXT,
    "apiKey" TEXT,
    "rpm" INTEGER,
    "tpm" INTEGER,
    "dropReasoning" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManagedLitellmRoute_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ManagedLitellmRoute_name_key" ON "ManagedLitellmRoute"("name");
