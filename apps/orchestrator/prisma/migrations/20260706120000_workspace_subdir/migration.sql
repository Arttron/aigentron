-- Optional subdirectory within the workspace repo that agents work in (cwd).
-- Empty/NULL = the repo root; the write boundary stays the whole worktree.
ALTER TABLE "AppSettings" ADD COLUMN "workspaceSubdir" TEXT;
