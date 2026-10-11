-- Knowledge base: bases, documents and chunks (searched in-app: BM25 + optional embeddings).
-- CreateTable
CREATE TABLE "KnowledgeBase" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "agents" JSONB NOT NULL,
    "chunking" JSONB NOT NULL,
    "embedProvider" TEXT,
    "embedModel" TEXT,
    "embedDim" INTEGER,
    "agentWrite" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeBase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeDoc" (
    "id" TEXT NOT NULL,
    "kbId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "source" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'file',
    "hash" TEXT NOT NULL,
    "size" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeDoc_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeChunk" (
    "id" TEXT NOT NULL,
    "kbId" TEXT NOT NULL,
    "docId" TEXT NOT NULL,
    "idx" INTEGER NOT NULL,
    "heading" TEXT NOT NULL DEFAULT '',
    "text" TEXT NOT NULL,
    "embedding" TEXT,

    CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeBase_name_key" ON "KnowledgeBase"("name");

-- CreateIndex
CREATE INDEX "KnowledgeDoc_kbId_idx" ON "KnowledgeDoc"("kbId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeDoc_kbId_hash_key" ON "KnowledgeDoc"("kbId", "hash");

-- CreateIndex
CREATE INDEX "KnowledgeChunk_kbId_idx" ON "KnowledgeChunk"("kbId");

-- CreateIndex
CREATE INDEX "KnowledgeChunk_docId_idx" ON "KnowledgeChunk"("docId");

-- AddForeignKey
ALTER TABLE "KnowledgeDoc" ADD CONSTRAINT "KnowledgeDoc_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "KnowledgeBase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "KnowledgeBase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_docId_fkey" FOREIGN KEY ("docId") REFERENCES "KnowledgeDoc"("id") ON DELETE CASCADE ON UPDATE CASCADE;
