-- CreateEnum
CREATE TYPE "TaskTier" AS ENUM ('routine', 'complex');

-- CreateEnum
CREATE TYPE "TierSource" AS ENUM ('explicit', 'heuristic');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('queued', 'running', 'needs_approval', 'done', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "AgentSessionStatus" AS ENUM ('starting', 'running', 'completed', 'errored', 'cancelled');

-- CreateEnum
CREATE TYPE "ModelProvider" AS ENUM ('ollama', 'anthropic', 'litellm');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('pending', 'approved', 'denied', 'timeout');

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "tier" "TaskTier" NOT NULL,
    "tierSource" "TierSource" NOT NULL DEFAULT 'explicit',
    "status" "TaskStatus" NOT NULL DEFAULT 'queued',
    "branch" TEXT,
    "worktreePath" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentSession" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "status" "AgentSessionStatus" NOT NULL DEFAULT 'starting',
    "provider" "ModelProvider" NOT NULL,
    "model" TEXT NOT NULL,
    "claudeSessionId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "AgentSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentEvent" (
    "id" TEXT NOT NULL,
    "agentSessionId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalRequest" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "agentSessionId" TEXT,
    "toolName" TEXT NOT NULL,
    "toolInput" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'pending',
    "resolvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "ApprovalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Task_status_idx" ON "Task"("status");

-- CreateIndex
CREATE INDEX "AgentSession_taskId_idx" ON "AgentSession"("taskId");

-- CreateIndex
CREATE INDEX "AgentEvent_agentSessionId_seq_idx" ON "AgentEvent"("agentSessionId", "seq");

-- CreateIndex
CREATE INDEX "AgentEvent_taskId_idx" ON "AgentEvent"("taskId");

-- CreateIndex
CREATE INDEX "ApprovalRequest_status_idx" ON "ApprovalRequest"("status");

-- CreateIndex
CREATE INDEX "ApprovalRequest_taskId_idx" ON "ApprovalRequest"("taskId");

-- AddForeignKey
ALTER TABLE "AgentSession" ADD CONSTRAINT "AgentSession_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentEvent" ADD CONSTRAINT "AgentEvent_agentSessionId_fkey" FOREIGN KEY ("agentSessionId") REFERENCES "AgentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_agentSessionId_fkey" FOREIGN KEY ("agentSessionId") REFERENCES "AgentSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
