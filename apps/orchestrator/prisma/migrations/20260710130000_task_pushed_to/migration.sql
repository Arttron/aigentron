-- Direct-push target (branch/commit) when work was pushed without a PR (shared mode),
-- kept distinct from prUrl (a real pull request).
ALTER TABLE "Task" ADD COLUMN "pushedTo" TEXT;
