# Ревью 05 — безопасность и инфраструктура

Дата: 2026-10-15. Версия: 0.1.58 (commit 5ed530d). Рецензент: senior security/infra, read-only.

Объём: `packages/shared/src/classify.ts` + `infra/hooks/pre-tool-use.mjs` (approval gate); auth / sessions / roles (`apps/orchestrator/src/{auth,identity,security,access,web}`); секреты; вся HTTP-поверхность (все контроллеры); раздача и загрузка файлов; CORS / trusted proxy / Cloudflare Access; `install.sh` + `install-bare.sh` + `infra/*.Dockerfile` + `docker-compose*.yml` + `Makefile`; CI (`.github`); зависимости; тесты; сборка/линт; гигиена репозитория; расхождения документации (`docs/authentication.md`, `docs/remote-access.md`, `README.md`) с кодом. Код и конфиги не менялись, ничего не коммитилось; запускались только read-only команды.

Проверено запуском:
- `pnpm test` → 54 файла / 483 теста зелёные (один тест требует `ffmpeg`).
- `pnpm typecheck` → зелёный; `pnpm lint` → зелёный (0 ошибок).
- `pnpm audit` → **1 critical / 34 high / 26 moderate / 2 low** на 735 зависимостей.
- `pnpm outdated -r` → 40+ пакетов устарели, включая мажорные: NestJS 11→12, Prisma 7→8-rc, ESLint 9→10, zod 4.4→4.6, react 19.2→19.3.

**Предостережение:** во время ревью рабочее дерево редактировалось параллельно (на маршруты `mcp-servers` прямо по ходу добавили `@Roles`; изменились `mcp.controller.ts`, `mcp-host.service.ts`, контроллеры attachments/workspace перешли на `pipeFile`). Таблица и находки — срез на момент последнего чтения; где это существенно, помечено.

Пометки: **[не проверено]** — вывод по чтению кода без воспроизведения эксплойта.

---

## 1. Модель защиты (для чтения находок)

- **Сессия.** `AuthGuard` — глобальный `APP_GUARD` (`auth/auth.module.ts:11`). Пока не задан ни один пароль — всё открыто (инстанс стартует в открытом режиме, в лог пишется предупреждение). С паролем любой `/api/*` требует cookie `lds_session` или `Authorization: Bearer`. Cookie = `base64url(JSON{exp,epoch,uid,ue,sid}).HMAC-SHA256(secret)`; `secret` и scrypt-хэши паролей лежат в `<secretsDir>/auth.json` (режим 0600). Исключения: `isPublicRoute` (health, auth/status|login|setup|logout, secret-links) и `isMachineRoute`+`isThisMachine` (approvals/check|wait, internal-mcp, research-mcp — только с адреса самой машины), плюс `/api/mcp` при заданном `MCP_TOKEN`.
- **Роли.** `RolesGuard` навешивается вручную `@UseGuards(RolesGuard)` + `@Roles(...)` на отдельные маршруты. Без `@Roles` мутирующий маршрут доступен любому вошедшему (reviewer / task_setter тоже), а при выключенном входе — кому угодно (роль берётся из `x-lds-user` либо дефолтный оператор, `identity/roles.guard.ts:46-54`).
- **Approval gate.** Хук `pre-tool-use.mjs` в процессе агента: сперва локальная классификация `classifyToolCall` из `LDS_SHARED_DIST` (benign → `allow` без сети), иначе `POST /api/approvals/check` (заголовок `x-lds-hook-secret`) и long-poll `/wait`. Fail-closed: любая ошибка/отсутствие проводки → `deny`. Хорошо: для Codex, у которого нет нативных allow/deny-списков, политика инструментов продублирована в хуке (`policyDenial`).
- **Изоляция окружения агента.** `packages/agent-runner/src/env.ts` — allow-list базовых env; `DATABASE_URL`, `REDIS_URL`, `GITHUB_TOKEN`, `ANTHROPIC_*`, `LITELLM_MASTER_KEY` в процесс агента НЕ передаются. Это сделано правильно.
- **Развёртывание.** Три режима: dev-compose (Postgres/Redis/LiteLLM отдельными сервисами), minimal (один контейнер + SQLite + LiteLLM дочерним процессом), bare-metal (systemd). Во всех трёх оркестратор и порождённые им агенты работают **под одним OS-пользователем — root** (Dockerfile без `USER`, bare-metal unit без `User=`, `install.sh` требует root). Это корень S-01.

---

## 2. Инвентаризация HTTP-маршрутов

158 маршрутов. Глобальный `AuthGuard` (сессия при включённом входе) есть на всех — в колонке «Guard» не повторяется. «Роли —» у мутирующего маршрута = доступно любому вошедшему независимо от роли. ⚠ в последней колонке — мутация без `@Roles`.

| Метод | Путь | Guard (кроме глобального AuthGuard) | Роли | Файл:строка | Замечание |
|---|---|---|---|---|---|
| GET | `/api/access` | — | — | `access/access.controller.ts:20` |  |
| PUT | `/api/access` | RolesGuard | operator, admin | `access/access.controller.ts:38` |  |
| GET | `/api/cloudflare-access` | — | — | `access/cloudflare-access.controller.ts:12` |  |
| PUT | `/api/cloudflare-access` | RolesGuard | operator, admin | `access/cloudflare-access.controller.ts:18` |  |
| POST | `/api/cloudflare-access/test` | RolesGuard | operator, admin | `access/cloudflare-access.controller.ts:32` |  |
| GET | `/api/admin-audit` | RolesGuard | operator, admin | `agent-registry/admin-audit.controller.ts:13` |  |
| GET | `/api/admin-audit/:id` | RolesGuard | operator, admin | `agent-registry/admin-audit.controller.ts:18` |  |
| GET | `/api/agents` | — | — | `agent-registry/agent-registry.controller.ts:37` |  |
| GET | `/api/agents/skills` | — | — | `agent-registry/agent-registry.controller.ts:43` |  |
| GET | `/api/agents/catalog` | — | — | `agent-registry/agent-registry.controller.ts:49` |  |
| GET | `/api/agents/catalog/:name` | — | — | `agent-registry/agent-registry.controller.ts:54` |  |
| GET | `/api/agents/:name` | — | — | `agent-registry/agent-registry.controller.ts:60` |  |
| POST | `/api/agents` | — | — | `agent-registry/agent-registry.controller.ts:65` | ⚠ мутация без @Roles — любой вошедший |
| PUT | `/api/agents/:name` | — | — | `agent-registry/agent-registry.controller.ts:70` | ⚠ мутация без @Roles — любой вошедший |
| DELETE | `/api/agents/:name` | — | — | `agent-registry/agent-registry.controller.ts:75` | ⚠ мутация без @Roles — любой вошедший |
| POST | `/api/approvals/check` | HookSecretGuard | — | `approvals/approvals.controller.ts:21` | machine-route: hook secret, только с этой машины |
| GET | `/api/approvals/:id/wait` | HookSecretGuard | — | `approvals/approvals.controller.ts:28` | machine-route: hook secret, только с этой машины |
| GET | `/api/approvals` | — | — | `approvals/approvals.controller.ts:41` |  |
| GET | `/api/approvals/:id` | — | — | `approvals/approvals.controller.ts:46` |  |
| POST | `/api/approvals/:id/secret` | RolesGuard | reviewer, operator, admin | `approvals/approvals.controller.ts:52` |  |
| POST | `/api/approvals/:id/decision` | RolesGuard | reviewer, operator, admin | `approvals/approvals.controller.ts:60` |  |
| GET | `/api/secret-links/:token` | — | — | `approvals/secret-links.controller.ts:12` | публичный: одноразовый токен = учётка |
| POST | `/api/secret-links/:token` | — | — | `approvals/secret-links.controller.ts:17` | публичный: одноразовый токен = учётка |
| POST | `/api/tasks/:id/attachments` | — | — | `attachments/attachments.controller.ts:16` | ⚠ мутация без @Roles — любой вошедший |
| GET | `/api/tasks/:id/attachments` | — | — | `attachments/attachments.controller.ts:22` |  |
| GET | `/api/tasks/:id/attachments/:file` | — | — | `attachments/attachments.controller.ts:27` |  |
| GET | `/api/auth/status` | — | — | `auth/auth.controller.ts:52` | публичный (без сессии) |
| POST | `/api/auth/setup` | — | — | `auth/auth.controller.ts:66` | публичный (без сессии) |
| POST | `/api/auth/login` | — | — | `auth/auth.controller.ts:78` | публичный (без сессии) |
| POST | `/api/auth/logout` | — | — | `auth/auth.controller.ts:91` | публичный (без сессии) |
| POST | `/api/auth/password` | — | — | `auth/auth.controller.ts:100` | ⚠ мутация без @Roles — любой вошедший |
| POST | `/api/auth/sign-out-everywhere` | — | — | `auth/auth.controller.ts:116` | ⚠ мутация без @Roles — любой вошедший |
| GET | `/api/auth/sessions` | RolesGuard | — | `auth/auth.controller.ts:125` |  |
| POST | `/api/auth/sessions/revoke-others` | RolesGuard | — | `auth/auth.controller.ts:132` | ⚠ мутация без @Roles — любой вошедший |
| DELETE | `/api/auth/users/:id/sessions` | RolesGuard | operator, admin | `auth/auth.controller.ts:146` |  |
| DELETE | `/api/auth/sessions/:id` | RolesGuard | — | `auth/auth.controller.ts:160` | ⚠ мутация без @Roles — любой вошедший |
| GET | `/api/auth/passwords` | RolesGuard | operator, admin | `auth/auth.controller.ts:172` |  |
| PUT | `/api/auth/users/:id/password` | RolesGuard | operator, admin | `auth/auth.controller.ts:180` |  |
| DELETE | `/api/auth/users/:id/password` | RolesGuard | operator, admin | `auth/auth.controller.ts:193` |  |
| GET | `/api/channels/kinds` | RolesGuard | operator, admin | `channels/channels.controller.ts:58` |  |
| GET | `/api/channels` | RolesGuard | operator, admin | `channels/channels.controller.ts:63` |  |
| POST | `/api/channels` | RolesGuard | operator, admin | `channels/channels.controller.ts:69` |  |
| PUT | `/api/channels/:id` | RolesGuard | operator, admin | `channels/channels.controller.ts:76` |  |
| DELETE | `/api/channels/:id` | RolesGuard | operator, admin | `channels/channels.controller.ts:83` |  |
| GET | `/api/channels/:id/pairings` | RolesGuard | operator, admin | `channels/channels.controller.ts:91` |  |
| POST | `/api/channels/:id/pairings/:chatId/allow` | RolesGuard | operator, admin | `channels/channels.controller.ts:97` |  |
| DELETE | `/api/channels/:id/pairings/:chatId` | RolesGuard | operator, admin | `channels/channels.controller.ts:105` |  |
| POST | `/api/channels/:id/test` | RolesGuard | operator, admin | `channels/channels.controller.ts:111` |  |
| POST | `/api/discussions` | RolesGuard | task_setter, operator, admin | `discussion/discussion.controller.ts:14` |  |
| GET | `/api/discussions/:taskId` | — | — | `discussion/discussion.controller.ts:21` |  |
| POST | `/api/discussions/:taskId/conclude` | RolesGuard | task_setter, operator, admin | `discussion/discussion.controller.ts:26` |  |
| POST | `/api/discussions/:taskId/stop` | RolesGuard | task_setter, operator, admin | `discussion/discussion.controller.ts:33` |  |
| GET | `/api/health` | — | — | `health/health.controller.ts:12` | публичный (без сессии) |
| ALL | `/api/internal-mcp` | — | — | `internal-mcp/internal-mcp.controller.ts:10` | machine-route: per-run bearer |
| GET | `/api/knowledge` | — | — | `knowledge/knowledge.controller.ts:27` |  |
| POST | `/api/knowledge/preview` | RolesGuard | operator, admin | `knowledge/knowledge.controller.ts:33` |  |
| POST | `/api/knowledge` | RolesGuard | operator, admin | `knowledge/knowledge.controller.ts:40` |  |
| GET | `/api/knowledge/:name` | — | — | `knowledge/knowledge.controller.ts:47` |  |
| PATCH | `/api/knowledge/:name` | RolesGuard | operator, admin | `knowledge/knowledge.controller.ts:52` |  |
| DELETE | `/api/knowledge/:name` | RolesGuard | operator, admin | `knowledge/knowledge.controller.ts:59` |  |
| GET | `/api/knowledge/:name/docs` | — | — | `knowledge/knowledge.controller.ts:67` |  |
| POST | `/api/knowledge/:name/docs/note` | RolesGuard | operator, admin | `knowledge/knowledge.controller.ts:72` |  |
| POST | `/api/knowledge/:name/docs/upload` | RolesGuard | operator, admin | `knowledge/knowledge.controller.ts:80` |  |
| POST | `/api/knowledge/:name/import/resource` | RolesGuard | operator, admin | `knowledge/knowledge.controller.ts:95` |  |
| POST | `/api/knowledge/:name/import/research` | RolesGuard | operator, admin | `knowledge/knowledge.controller.ts:102` |  |
| DELETE | `/api/knowledge/docs/:docId` | RolesGuard | operator, admin | `knowledge/knowledge.controller.ts:109` |  |
| POST | `/api/knowledge/:name/search` | RolesGuard | reviewer, task_setter, operator, admin | `knowledge/knowledge.controller.ts:118` |  |
| POST | `/api/knowledge/:name/reembed` | RolesGuard | operator, admin | `knowledge/knowledge.controller.ts:126` |  |
| GET | `/api/litellm/routes` | — | — | `litellm/litellm.controller.ts:9` |  |
| GET | `/api/maintenance/disk` | RolesGuard | operator, admin | `maintenance/maintenance.controller.ts:17` |  |
| POST | `/api/maintenance/relieve` | RolesGuard | operator, admin | `maintenance/maintenance.controller.ts:23` |  |
| GET | `/api/maintenance/report` | RolesGuard | operator, admin | `maintenance/maintenance.controller.ts:28` |  |
| POST | `/api/maintenance/cleanup` | RolesGuard | operator, admin | `maintenance/maintenance.controller.ts:34` |  |
| GET | `/api/mcp-servers` | — | — | `mcp/mcp.controller.ts:30` |  |
| POST | `/api/mcp-servers/:name/discover` | RolesGuard | operator, admin | `mcp/mcp.controller.ts:38` |  |
| POST | `/api/mcp-servers` | RolesGuard | operator, admin | `mcp/mcp.controller.ts:45` |  |
| PUT | `/api/mcp-servers/:name` | RolesGuard | operator, admin | `mcp/mcp.controller.ts:52` |  |
| DELETE | `/api/mcp-servers/:name` | RolesGuard | operator, admin | `mcp/mcp.controller.ts:59` |  |
| GET | `/api/mcp/status` | — | — | `mcp-host/mcp-host.controller.ts:27` |  |
| ALL | `/api/mcp` | — | — | `mcp-host/mcp-host.controller.ts:38` | MCP_TOKEN (или сессия, если токен не задан) |
| GET | `/api/media` | — | — | `media/media.controller.ts:19` |  |
| POST | `/api/media/digest` | RolesGuard | operator, admin, task_setter | `media/media.controller.ts:25` |  |
| POST | `/api/media/look` | RolesGuard | operator, admin, task_setter | `media/media.controller.ts:38` |  |
| PUT | `/api/vision` | RolesGuard | operator, admin | `media/media.controller.ts:50` |  |
| POST | `/api/vision/test` | RolesGuard | operator, admin | `media/media.controller.ts:59` |  |
| GET | `/api/packs` | — | — | `packs/packs.controller.ts:12` |  |
| GET | `/api/packs/:name` | — | — | `packs/packs.controller.ts:17` |  |
| POST | `/api/packs/:name/install` | RolesGuard | operator, admin | `packs/packs.controller.ts:23` |  |
| GET | `/api/providers` | — | — | `providers/providers.controller.ts:43` |  |
| POST | `/api/providers` | — | — | `providers/providers.controller.ts:48` | ⚠ мутация без @Roles — любой вошедший |
| PUT | `/api/providers/:name` | — | — | `providers/providers.controller.ts:64` | ⚠ мутация без @Roles — любой вошедший |
| GET | `/api/providers/codex-login` | RolesGuard | operator, admin | `providers/providers.controller.ts:70` |  |
| POST | `/api/providers/models-preview` | — | — | `providers/providers.controller.ts:78` | ⚠ мутация без @Roles — любой вошедший |
| POST | `/api/providers/:name/test` | — | — | `providers/providers.controller.ts:84` | ⚠ мутация без @Roles — любой вошедший |
| GET | `/api/providers/:name/models` | — | — | `providers/providers.controller.ts:90` |  |
| DELETE | `/api/providers/:name` | — | — | `providers/providers.controller.ts:95` | ⚠ мутация без @Roles — любой вошедший |
| GET | `/api/questions` | — | — | `questions/questions.controller.ts:15` |  |
| GET | `/api/questions/:id` | — | — | `questions/questions.controller.ts:20` |  |
| GET | `/api/questions/:id/image` | — | — | `questions/questions.controller.ts:26` |  |
| POST | `/api/questions/:id/answer` | RolesGuard | reviewer, operator, admin, task_setter | `questions/questions.controller.ts:39` |  |
| ALL | `/api/research-mcp` | — | — | `research/research.controller.ts:10` | machine-route: БЕЗ собственного токена |
| GET | `/api/resources` | — | — | `resources/resources.controller.ts:14` |  |
| POST | `/api/resources` | RolesGuard | operator, admin | `resources/resources.controller.ts:20` |  |
| POST | `/api/resources/upload` | RolesGuard | operator, admin | `resources/resources.controller.ts:31` |  |
| GET | `/api/resources/:id` | — | — | `resources/resources.controller.ts:42` |  |
| GET | `/api/resources/:id/file` | — | — | `resources/resources.controller.ts:48` |  |
| PUT | `/api/resources/:id` | RolesGuard | operator, admin | `resources/resources.controller.ts:60` |  |
| DELETE | `/api/resources/:id` | RolesGuard | operator, admin | `resources/resources.controller.ts:67` |  |
| GET | `/api/schedules` | — | — | `schedules/schedules.controller.ts:12` |  |
| POST | `/api/schedules` | RolesGuard | operator, admin | `schedules/schedules.controller.ts:17` |  |
| PUT | `/api/schedules/:id` | RolesGuard | operator, admin | `schedules/schedules.controller.ts:24` |  |
| DELETE | `/api/schedules/:id` | RolesGuard | operator, admin | `schedules/schedules.controller.ts:31` |  |
| POST | `/api/schedules/:id/run` | RolesGuard | operator, admin | `schedules/schedules.controller.ts:40` |  |
| GET | `/api/settings` | — | — | `settings/settings.controller.ts:66` |  |
| PUT | `/api/settings` | — | — | `settings/settings.controller.ts:71` | ⚠ мутация без @Roles — любой вошедший |
| POST | `/api/settings/verify-wizard-password` | — | — | `settings/settings.controller.ts:81` | сравнение не constant-time, без лимита попыток |
| GET | `/api/stats/usage` | RolesGuard | operator, admin | `stats/stats.controller.ts:13` |  |
| POST | `/api/tasks` | RolesGuard | task_setter, operator, admin | `tasks/tasks.controller.ts:15` |  |
| GET | `/api/tasks` | — | — | `tasks/tasks.controller.ts:22` |  |
| GET | `/api/tasks/type-counts` | — | — | `tasks/tasks.controller.ts:28` |  |
| GET | `/api/tasks/status-counts` | — | — | `tasks/tasks.controller.ts:34` |  |
| GET | `/api/tasks/:id` | — | — | `tasks/tasks.controller.ts:39` |  |
| GET | `/api/tasks/:id/transcript` | — | — | `tasks/tasks.controller.ts:44` |  |
| POST | `/api/tasks/:id/start` | — | — | `tasks/tasks.controller.ts:50` | ⚠ мутация без @Roles — любой вошедший |
| POST | `/api/tasks/:id/done` | RolesGuard | task_setter, operator, admin | `tasks/tasks.controller.ts:56` |  |
| POST | `/api/tasks/:id/follow-up` | — | — | `tasks/tasks.controller.ts:63` | ⚠ мутация без @Roles — любой вошедший |
| GET | `/api/tasks/:id/pending-follow-ups` | — | — | `tasks/tasks.controller.ts:69` |  |
| PATCH | `/api/tasks/:id/pending-follow-ups/:pendingId` | — | — | `tasks/tasks.controller.ts:74` | ⚠ мутация без @Roles — любой вошедший |
| DELETE | `/api/tasks/:id/pending-follow-ups/:pendingId` | — | — | `tasks/tasks.controller.ts:87` | ⚠ мутация без @Roles — любой вошедший |
| POST | `/api/tasks/:id/subtasks` | RolesGuard | task_setter, operator, admin | `tasks/tasks.controller.ts:93` |  |
| POST | `/api/tasks/:id/cancel` | — | — | `tasks/tasks.controller.ts:108` | ⚠ мутация без @Roles — любой вошедший |
| DELETE | `/api/tasks/:id` | — | — | `tasks/tasks.controller.ts:113` | ⚠ мутация без @Roles — любой вошедший |
| GET | `/api/titles` | — | — | `titles/titles.controller.ts:11` |  |
| PUT | `/api/titles` | RolesGuard | operator, admin | `titles/titles.controller.ts:16` |  |
| POST | `/api/titles/test` | RolesGuard | operator, admin | `titles/titles.controller.ts:23` |  |
| POST | `/api/translate` | RolesGuard | reviewer, task_setter, operator, admin | `titles/translate.controller.ts:11` |  |
| GET | `/api/update` | — | — | `update/update.controller.ts:11` |  |
| POST | `/api/update/check` | — | — | `update/update.controller.ts:16` | ⚠ мутация без @Roles — любой вошедший |
| POST | `/api/update/apply` | RolesGuard | operator, admin | `update/update.controller.ts:22` |  |
| GET | `/api/users` | — | — | `users/users.controller.ts:36` |  |
| GET | `/api/users/:id` | — | — | `users/users.controller.ts:41` |  |
| POST | `/api/users` | RolesGuard | operator, admin | `users/users.controller.ts:46` |  |
| PUT | `/api/users/:id` | RolesGuard | operator, admin | `users/users.controller.ts:59` |  |
| DELETE | `/api/users/:id` | RolesGuard | operator, admin | `users/users.controller.ts:66` |  |
| GET | `/api/voice` | — | — | `voice/voice.controller.ts:36` |  |
| PUT | `/api/voice` | RolesGuard | operator, admin | `voice/voice.controller.ts:42` |  |
| POST | `/api/voice/test` | RolesGuard | operator, admin | `voice/voice.controller.ts:50` |  |
| POST | `/api/voice/transcribe` | RolesGuard | operator, admin, task_setter | `voice/voice.controller.ts:59` |  |
| POST | `/api/voice/speak` | RolesGuard | operator, admin, task_setter | `voice/voice.controller.ts:74` |  |
| GET | `/api/web-server` | — | — | `web/web-server.controller.ts:12` |  |
| PUT | `/api/web-server/config` | RolesGuard | operator, admin | `web/web-server.controller.ts:17` |  |
| PUT | `/api/web-server/certificate` | RolesGuard | operator, admin | `web/web-server.controller.ts:27` |  |
| DELETE | `/api/web-server/certificate` | RolesGuard | operator, admin | `web/web-server.controller.ts:37` |  |
| GET | `/api/workspace` | — | — | `workspace/workspace.controller.ts:13` |  |
| GET | `/api/workspace/files` | — | — | `workspace/workspace.controller.ts:18` |  |
| GET | `/api/workspace/file` | — | — | `workspace/workspace.controller.ts:23` |  |
| PUT | `/api/workspace/file` | RolesGuard | operator, admin | `workspace/workspace.controller.ts:36` |  |
| DELETE | `/api/workspace/file` | RolesGuard | operator, admin | `workspace/workspace.controller.ts:43` |  |
---

## 3. Находки

| ID | Серьёзность | Тип | Где | Что | Сценарий | Исправление | Труд. |
|---|---|---|---|---|---|---|---|
| S-01 | critical | security | `infra/dev.Dockerfile`, `infra/minimal.Dockerfile` (нет `USER`), `install.sh:180` + unit `install.sh:605-635` (без `User=`), `auth/auth.service.ts:62-99`, `auth-core.ts:48` | Агент выполняется тем же OS-пользователем (root), что и оркестратор. Всё, что защищают права 0600/0700, агенту доступно на чтение и запись: `secrets/auth.json` (ключ подписи сессий + хэши паролей), `secrets/tls/privkey.pem`, `secrets/codex/`, `access.json`, `.env`, SQLite-БД `/data/orchestrator.db`, сам хук и `packages/shared/dist`. Известный пункт бэклога (`docs/BACKLOG.md:231`, «Приоритет №1»); на сегодня не исправлено. | Агент с shell читает ключ подписи из `auth.json` и локально выпускает себе валидную cookie оператора (HMAC-проверка в `verifySession` пройдёт, т.к. ключ тот же) → полный обход входа и ролей. Либо правит БД/`.env` напрямую, либо подменяет `dist` классификатора, обходя approval gate для всех будущих запусков. Approval gate это НЕ закрывает (S-06). | Настоящее: запускать агентов под отдельным uid/gid без доступа к `secrets/`/БД (`setpriv`/`su-exec`/`gosu`; SDK даёт `spawnClaudeCodeProcess` для своего `spawn` с `uid`). Дёшево и частично: (а) добавить `sid` в каждую активную сессию (уже есть) и перейти к серверному allow-list валидных `sid` вместо чистой проверки подписи, чтобы одной кражи ключа было мало; (б) вынести `secrets/` на права, недоступные процессу агента, если он уже под отдельным uid. До этого — не обещать в `docs/authentication.md`, что approval gate это закрывает (сейчас честно сказано в «Honest limits» — оставить). | L |
| S-02 | high | security | `settings/settings.controller.ts:71`, `agent-registry/agent-registry.controller.ts:65,70,75`, `providers/providers.controller.ts:48,64,95,78,84` | Мутирующие маршруты без `@Roles`: `PUT /api/settings`, `POST/PUT/DELETE /api/agents/:name`, `POST/PUT/DELETE /api/providers`, `POST /api/providers/models-preview`, `POST /api/providers/:name/test`. Доступны любому вошедшему, включая reviewer и task_setter. `mcp-servers` этот дефект уже закрыли по ходу ревью — тот же паттерн надо применить здесь. | Пользователь-reviewer (может только смотреть) правит `PUT /api/settings`: задаёт `repoUrl`/`githubToken` (клон произвольного репозитория, подстановка токена) или `agentInstructions` (вставляется в промпт каждого агента). Через `POST /api/agents` создаёт определение агента с нужными `allowedTools`/`mcp` и запускает задачу → фактически исполнение кода на сервере. Через `providers` подменяет `baseUrl` провайдера на свой сервер и перехватывает трафик моделей. | Навесить `@UseGuards(RolesGuard)` + `@Roles('operator','admin')` на все мутации settings/agents/providers (как сделано для channels/mcp-servers). `models-preview`/`test` можно оставить task_setter+, но не reviewer по умолчанию. | S |
| S-03 | high | deps | `pnpm-lock.yaml`; `apps/orchestrator/package.json` (`@modelcontextprotocol/sdk`, `@nestjs/platform-express`→multer, `socket.io`) | `pnpm audit`: 1 critical + 34 high. Выполняемые в рантайме: `proxy-addr` **critical** (IP-spoofing) и `@modelcontextprotocol/sdk` **high** (OAuth-утечка) тянутся через MCP SDK; `multer` **high** (несколько DoS) через `@nestjs/platform-express`; `engine.io`/`socket.io-parser` **high** (DoS) через `socket.io`; `mysql2`/`hono`/`@hono/node-server`/`valibot` — через `prisma`/`@prisma/dev` (CLI/дев-путь, в рантайме не грузятся). Львиная доля `brace-expansion`/`js-yaml`/`fast-uri` — через eslint/@nestjs/cli/typescript-eslint, то есть dev-only. | `multer` DoS: внешний клиент (при публичном доступе) шлёт multipart со спец-именами полей → память/CPU. `engine.io`/`socket.io-parser` DoS по WebSocket. `proxy-addr` — только если express-слой MCP SDK реально парсит доверенные прокси; наш `clientAddress` свой, express.trust proxy мы не используем **[не проверено — скорее недостижимо]**. | Поднять версии: `@modelcontextprotocol/sdk` → ≥1.31, `@nestjs/platform-express` (→ multer ≥2.3), `socket.io` → 4.8.4. Прогнать `pnpm up` для dev-цепочек (eslint/typescript-eslint/@nestjs/cli). Добавить `pnpm audit --prod` в CI как необваливающий шаг. | M |
| S-04 | medium | security | `research/research.controller.ts:10`, `research/research-mcp.service.ts:54`, ср. `internal-mcp/internal-mcp.service.ts:47` и `approvals/hook-secret.guard.ts` | `/api/research-mcp` (`ALL`) защищён только `isMachineRoute`+`isThisMachine` — собственного токена, в отличие от `internal-mcp` (per-run bearer) и `approvals` (hook secret), у него нет. Любой процесс на той же машине (в т.ч. агент) обращается к инструментам research без ограничения. | Инструменты read-only (search/fetch/verify_quote), но `fetch_page` — это серверный исходящий запрос по произвольному URL = SSRF-плечо изнутри машины и способ агенту ходить в сеть мимо shell-гейта по исходящему трафику. Impact ограничен, т.к. доступ только локальный. | Дать research-mcp такой же per-run bearer, как у internal-mcp, либо хотя бы проверять `x-lds-hook-secret`. SSRF в `fetchPage` проверить на блокировку приватных диапазонов (см. S-03: `ip-address`-CVE в зависимостях про SSRF-bypass). | M |
| S-05 | medium | security | `settings/settings.controller.ts:81-90` | `POST /api/settings/verify-wizard-password` — публичный (не в `isPublicRoute`, но POST без `@Roles`; при включённом входе требует сессии, при выключенном — открыт), сравнение `dto.password === this.config.wizardAdminPassword` не constant-time и без лимита попыток. Гейтит «advanced mode» мастера настройки. | На открытом инстансе (до установки пароля) — перебор `WIZARD_ADMIN_PASSWORD` без троттлинга; тайминг-сайд-канал. Сам код честно помечен «не security boundary», но значение задаётся пользователем и переиспользуется как ворота к сырым настройкам. | `timingSafeEqual`, прогнать через `LoginLimiter` по адресу клиента (уже есть класс), и явно требовать operator/admin, если вход включён. | S |
| S-06 | medium | security | `packages/shared/src/classify.ts:187-222` | Классификатор опасных shell-команд — набор регулярок. Деструктивные/секретные паттерны ловятся, но это денай-лист: обфускация (конкатенация строк, переменные, base64, интерпретатор) обходит его. Это осознанный v1-компромисс и задокументировано в бэклоге. | Бенинные с виду команды, которые не ждёт ни один человек у approval-карточки, проходят как `allow` в локальном fast-path хука и читают/пишут то, до чего дотянется процесс (см. S-01). То есть сам по себе гейт даёт ложное чувство защиты секретов. | Чинится через S-01 (реальная изоляция), не через расширение регулярок. Здесь — только не позиционировать классификатор как границу для секретов; secret-path правила (`SECRET_PATH_PATTERNS`) полезны для «случайного» чтения, не против намеренного обхода. | — (зависит от S-01) |
| S-07 | medium | infra | `docker-compose.minimal.yml:34-36`, `install.sh:539-552` | Полный dev-compose публикует порты на `${BIND_ADDRESS:-127.0.0.1}` (безопасный дефолт). А minimal-compose публикует `3001:3001` (и install.sh docker — `-p 3001:3001 -p 80:80 -p 443:443`) на `0.0.0.0`. При этом свежий инстанс стартует **без пароля** (открыт). | На хосте с публичным IP minimal/bare-установка сразу доступна из сети, и до того, как оператор зайдёт и задаст пароль, любой, кто найдёт адрес, — оператор (login-экран даже выдаёт список пользователей). `SecurityPostureService` пишет предупреждение в лог, но это advisory. | Для minimal/install.sh тоже завязать публикацию на `BIND_ADDRESS`/`127.0.0.1` по умолчанию с явным opt-in; либо при первом старте без пароля требовать установки пароля перед приёмом не-loopback запросов; README — усилить предупреждение «задай пароль до публикации». | M |
| S-08 | low | infra | `docker-compose.yml` (`LDS_HOOK_SECRET:-dev-hook-secret-change-me`, `LITELLM_MASTER_KEY:-sk-lds-master-dev`) | Dev-дефолты встроены в compose. `init-env.sh` генерит случайный `LITELLM_MASTER_KEY` только на свежем volume и только для полного профиля; `LDS_HOOK_SECRET` остаётся дефолтным, если не задан в `.env`. | Дефолтный hook secret опасен лишь в связке с доступом к `approvals/check`, который и так ограничен `isThisMachine`; дефолтный master key — только при не-loopback LiteLLM (ловится `SecurityPostureService`). Impact низкий из-за loopback-привязки. | `init-env.sh` генерить и `LDS_HOOK_SECRET`; в minimal-образе не оставлять `LITELLM_MASTER_KEY=sk-lds-master-dev` фиксированным в `ENV` Dockerfile — генерить в entrypoint при первом старте. | S |
| S-09 | medium | test | нет тестов: `auth/auth.guard`, `auth/auth.service`, `identity/roles.guard`, `approvals/hook-secret.guard`, `approvals/approvals.service`, `access/access.service` | Чистые модули (`auth-core`, `access-core`, `cloudflare-access-core`) покрыты хорошо, но сами точки принятия authz-решения (guard’ы, сервис одобрений) юнит-тестов не имеют. 483 теста — почти все на pure-функциях. | Регрессия в guard/роли (ровно класс S-02) не ловится тестами; изменение `AuthGuard`/`RolesGuard` может тихо открыть маршрут. | Добавить тесты на `RolesGuard` (сессия vs `x-lds-user`, отсутствие роли → 403), `AuthGuard` (public/machine-route/mcp-token ветки), `HookSecretGuard`. Хотя бы smoke e2e на «мутация без сессии → 401» по списку из §2. | M |
| S-10 | low | hygiene | `agent/research-cache/9538ab6d163c8457894603ed.json` в git; `apps/dashboard/src/assets/aigentron_admin_states.json` (260 КБ) | В репозиторий закоммичен сгенерированный кэш research (`agent/research-cache/*.json`) — это рантайм-артефакт, а не исходник; `.gitignore` исключает `/agent/resources/`, `/agent/runs/` и пр., но не `research-cache`. Крупных бинарников/`.env`/ключей в истории не найдено (gitleaks в CI + ручной grep — чисто). | Мусор в истории и в публичном зеркале (publish/allowlist включает `agent`). Утечки секретов нет. | Добавить `/agent/research-cache/` в `.gitignore` и `.dockerignore`, убрать файл из индекса. | S |
| S-11 | low | docs | `docs/authentication.md:34,77` | Дрейф: таблица и «Honest limits» утверждают, что «General settings, agents **and MCP servers** are open to every signed-in user». По факту `mcp-servers` уже закрыты ролью (по ходу ревью), а `settings`/`agents`/`providers` действительно открыты — то есть текст одновременно и устарел (про MCP), и описывает дырку как штатное поведение (S-02). | Оператор полагается на документацию и не осознаёт, что reviewer может менять providers/settings/agents. | После фикса S-02 переписать абзац: перечислить, что именно теперь требует operator/admin; убрать MCP из «open». Проверить `remote-access.md` (там про роли корректно по сути). | S |
| S-12 | low | infra | `package.json` (`engines.node >=20.11`) vs `infra/*.Dockerfile` (`node:22`), `install.sh:278` (требует node ≥22) | `engines` занижает минимум: образы и bare-metal требуют Node 22 (`better-sqlite3`, SDK), а манифест разрешает 20.11. Локально ревью шло на Node 20.19 — тесты прошли, но рантайм целится в 22. | Установка на Node 20 по `engines` формально допустима, но не совпадает с поддерживаемым рантаймом → трудноуловимые расхождения. | Поднять `engines.node` до `>=22` (совпасть с Dockerfile/installer). | S |

Положительное (чтобы не «чинить» уже сделанное): env-allowlist для агентов; fail-closed approval-хук; secret-links (одноразовый, write-only, in-memory, TTL 10 мин, лимит попыток); constant-time сравнение `MCP_TOKEN` и per-run bearer internal-mcp; раздача файлов форсирует `Content-Disposition: attachment` + `nosniff` для не-inline типов (html/svg/js не исполняются как same-origin); Cloudflare Access с полной проверкой JWT (подпись/iss/aud/exp) и fail-closed при недоступности ключей; строгий режим доменов учитывает relayed-заголовки; лимит попыток входа с двойным ключом (cf-ip при доверенном пире, иначе TCP-peer); гейтинг браузерной навигации только на http(s)+localhost; log-rotation в compose; gitleaks в релизном CI по полному дереву.

---

## 4. Топ-10 по снижению риска на единицу усилий

1. **S-02** (high / S) — навесить `@Roles('operator','admin')` на мутации settings/agents/providers. Копипаст уже применённого к channels/mcp-servers паттерна, закрывает реальную эскалацию привилегий. Лучшее соотношение.
2. **S-07** (medium / M) — убрать публикацию minimal/install.sh на `0.0.0.0` по умолчанию / требовать пароль до приёма не-loopback. Закрывает «открытый инстанс в сети».
3. **S-03** (high / M) — поднять рантайм-зависимости (MCP SDK, multer, socket.io); добавить `pnpm audit --prod` в CI.
4. **S-05** (medium / S) — `timingSafeEqual` + троттлинг + роль на `verify-wizard-password`.
5. **S-04** (medium / M) — per-run bearer для research-mcp + проверка SSRF-фильтра в `fetchPage`.
6. **S-09** (medium / M) — юнит/smoke-тесты на guard’ы и «мутация без сессии → 401».
7. **S-11** (low / S) — привести `docs/authentication.md` в соответствие после S-02.
8. **S-08** (low / S) — генерировать `LDS_HOOK_SECRET` и master key вместо фиксированных дефолтов.
9. **S-10** (low / S) — `.gitignore`/`.dockerignore` для `agent/research-cache/`.
10. **S-01** (critical / L) — реальная OS-изоляция агентов (отдельный uid, недоступ к `secrets/`). Наибольшее снижение риска, но самое дорогое; дешёвое частичное смягчение (серверный allow-list `sid`) стоит сделать как промежуточный шаг.

Примечание к приоритету: S-01 — единственный critical и корень доверия (кража ключа подписи → подделка cookie), но он дорогой и уже стоит №1 в бэклоге как «нужна OS-изоляция». До него S-02/S-07/S-05 снимают самые дешёвые реальные дыры в HTTP-поверхности, а классификатор (S-06) не следует позиционировать как защиту секретов.
