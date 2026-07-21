-- Allowlist rules that auto-approve matching dangerous tool calls.
CREATE TABLE "ApprovalException" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "taskId" TEXT,
    "toolName" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalException_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ApprovalException_toolName_idx" ON "ApprovalException"("toolName");
CREATE INDEX "ApprovalException_taskId_idx" ON "ApprovalException"("taskId");
