-- Approvals for the tasks a schedule starts (ask | off). Null = follow the project / global setting.
ALTER TABLE "Schedule" ADD COLUMN "approvalMode" TEXT;
