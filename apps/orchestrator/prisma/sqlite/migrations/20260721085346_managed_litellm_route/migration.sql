-- CreateTable
CREATE TABLE "ManagedLitellmRoute" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "backend" TEXT NOT NULL,
    "apiBase" TEXT,
    "apiKey" TEXT,
    "rpm" INTEGER,
    "tpm" INTEGER,
    "dropReasoning" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "ManagedLitellmRoute_name_key" ON "ManagedLitellmRoute"("name");
