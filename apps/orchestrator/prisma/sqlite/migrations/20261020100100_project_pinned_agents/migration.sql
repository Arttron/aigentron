-- Agents pinned to a project: the New task list of that project offers only these (comma-separated names). Null = every agent, as before.
ALTER TABLE "Project" ADD COLUMN "pinnedAgents" TEXT;
