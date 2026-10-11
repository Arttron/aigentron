-- A finished task waits for the person to accept it: `review` (new). `done` is then set by a person.
ALTER TYPE "TaskStatus" ADD VALUE IF NOT EXISTS 'review';
