-- Questions agents ask humans (ask_user): answer buttons in the dashboard and in channels.
CREATE TABLE "AgentQuestion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "agentSessionId" TEXT,
    "question" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "allowText" BOOLEAN NOT NULL DEFAULT true,
    "image" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "answer" TEXT,
    "answerIndex" INTEGER,
    "answeredBy" TEXT,
    "answeredById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" DATETIME
);

CREATE INDEX "AgentQuestion_taskId_idx" ON "AgentQuestion"("taskId");
CREATE INDEX "AgentQuestion_status_idx" ON "AgentQuestion"("status");
