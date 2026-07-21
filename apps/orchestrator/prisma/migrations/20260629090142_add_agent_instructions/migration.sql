-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN     "agentInstructions" TEXT NOT NULL DEFAULT 'Before changing anything, inspect the project in your working directory: list the files and read the README and key config files to understand its structure and conventions. Then implement the task with minimal, focused changes that match the existing style.';
