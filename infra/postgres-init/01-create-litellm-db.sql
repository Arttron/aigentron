-- LiteLLM keeps its own model store in a SEPARATE database (it runs a
-- destructive prisma sync that would otherwise wipe the orchestrator schema).
-- Runs only on a fresh data volume (docker-entrypoint-initdb.d).
SELECT 'CREATE DATABASE litellm'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'litellm')\gexec
