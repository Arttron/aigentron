# Ревью проекта (2026-10-15, v0.1.58): сводка и план исправлений — редакция 2

Пять независимых ревью (код только читался): `01-executor-tasks.md` (E-, 37), `02-channels-schedules.md` (C-, 51), `03-files-knowledge.md` (F-, 60), `04-dashboard.md` (D-, 47), `05-security-infra.md` (S-, 12 + инвентарь 158 маршрутов) ≈ 207 находок. Редакция 2 — после независимой перепроверки (Fable, 2026-10-15, `main` 812fe7d): все critical/high и 14 medium сверены с кодом; прогнаны `pnpm test` (55 файлов / 486 тестов), `pnpm lint`, `pnpm typecheck` — зелёные; `pnpm audit`; три дополнительных прохода по областям, которые ревью не покрыло (БД/миграции/обновление/бэкап; очередь/failover/учёт токенов; код этой недели и работа за Cloudflare). Усилия: S ≈ до дня, M ≈ 2–3 дня, L ≈ неделя.

## 0. Правки после ревью Fable

**Статистика.** 19 critical/high: 15 CONFIRMED, 4 ALREADY FIXED (F-01, F-02, C-01, C-02 — в `main` сегодня, §1), 0 ложных. 14 medium выборочно: 13 CONFIRMED, 1 PARTIALLY (D-27). Плюс 3 утверждения ревью, подтверждённые дополнительным проходом (C-18, C-36, E-34). `pnpm audit --prod`: 1 critical / 17 high / 22 moderate (в полном дереве 1 / 34 / 26 — цифра ревью включает dev-цепочки).

| ID | Вердикт | Примечание |
|---|---|---|
| S-01, S-02, S-03, S-05, S-07, S-10, S-12 | CONFIRMED | S-02 шире, чем в тексте: без `@Roles` ещё `POST /tasks/:id/{start,follow-up,cancel}`, `DELETE /tasks/:id`, `PATCH/DELETE …/pending-follow-ups/:id`, `POST /tasks/:id/attachments`, `POST /update/check` (в инвентаре 05 помечены ⚠). Закрывать одним проходом |
| E-01, E-02, E-03 | CONFIRMED | E-03: `drainPendingFollowUp` не смотрит на статус; после `cancelled` ставит `queued`, затем старый прогон пишет `stalled` поверх нового |
| E-04 | PARTIALLY | Стоимость реальна и **больше**, чем написано: system-блок стоит перед messages, его изменение сбрасывает кэш всей переписки на каждом follow-up (оплата 125 % за запись вместо 10 % за чтение). Но предложенная правка (переставить блоки внутри `appendSystemPrompt`) скорее всего не поможет: кэш Anthropic совпадает по границам content-блоков, а весь append — одна строка в одном блоке. Правильное исправление: убрать из append всё, что меняется между прогонами (карта проекта, memory-дайджест), и отдавать это в тексте сообщения; append сессии держать байт-в-байт одинаковым. Усилие то же (S). Критерий — `cacheRead > 0` на 2-м follow-up в Stats |
| E-09, E-10, E-21, E-22, E-12, E-34 | CONFIRMED | E-12: SDK 0.3.295 — «Timeout in seconds»; код пишет миллисекунды. Но само по себе не опасно: скрипт хука сам ограничивает ожидание. Опасно вместе с X-RUN-1 (см. ниже) |
| C-04, C-05, C-06, C-09, C-13, C-18, C-21, C-36 | CONFIRMED | C-05: Telegram подтверждает апдейт только следующим `getUpdates` с бо́льшим `offset`, поэтому последняя пачка после `reload()` приходит снова |
| F-04, F-05, F-07, F-08, F-14, F-17 | CONFIRMED | F-07: срабатывает только при `WORKSPACE_DIR=` (пустая строка) в `.env`; в `.env.example` переменная закомментирована — риск у того, кто раскомментирует и оставит пустой |
| D-01/D-02, D-03/D-04, D-18, D-26 | CONFIRMED | D-18: `ApprovalDock` в `App` на всех страницах + те же карточки в `TaskListPage` — двойные карточки на главной подтверждены |
| D-27 | PARTIALLY | маскот уже грузится динамическим `import()` (отдельные чанки), но при монтировании `AdminChat` на каждой странице; правка — отложить до idle/первого открытия |
| F-01, F-02, C-01, C-02 | ALREADY FIXED | c39279d, 6e38f1b |

**Понижено.** «Серверный allow-list `sid`» как смягчение S-01: агент под тем же uid читает и `auth.json`, и SQLite, так что allow-list в БД обходится так же; оставлено как гигиена, не как смягчение S-01. Ложных находок не обнаружено.

**Новые находки X-\*** (§2a): 7 high — X-NEW-1 (`read_document` у чат-агентов читает `runs/*/codex-home/auth.json`), X-RUN-1 (хук approval по умолчанию fail-open при сбое/таймауте), X-Q-6 (ошибка Prisma в `tick()` очереди = `process.exit`), X-Q-1/X-Q-2 (два прогона одной задачи одновременно; `running` поверх `cancelled`), X-COST-1 (стоимость при resume считается кумулятивно → квадратичный рост в Stats), X-DB-1/X-UPD-1 (обновление мигрирует живую БД без снимка, упавшая миграция блокирует и откат), X-BAK-1 (бэкапа нет), X-FO-1 (failover на follow-up теряет весь контекст).

**Изменения в плане.** (1) Волна 0 сужена до правок без изменения поведения для владельца и упорядочена по файлам (§5). (2) S-07 заменён на «installer сам задаёт пароль»: привязка портов не меняется (владелец на AWS за Cloudflare на 80/443). (3) Снимок БД перед миграцией — в волну 0 (0.1.59 без миграций), бэкап/restore и все миграции — волна 1. (4) Рефакторинги волны 2 урезаны: разбиение executor/channel-manager на 9 сервисов для продукта одного человека не окупается; оставлены выносы, нужные для тестов или бага. (5) S-01 для Docker оценён как M (не L) с рецептом. (6) Добавлены критерии приёмки и регрессионный чек-лист по волнам.

## 1. Уже исправлено по ходу ревью (в `main`, ещё не выпущено)

| ID | Что | Как проверено |
|---|---|---|
| F-01 (critical) | GET вложения с именем `..` ронял сервер | `pipe-file.ts` + тест `pipe-file.test.ts` |
| F-02 | Скачивание файлов с не-ASCII именами давало 500 | RFC 5987 в `attachments.controller.ts` |
| C-01 (high) | `/mcp-servers` без ролей — любой вошедший мог запустить команду на хосте | `@Roles('operator','admin')` |
| C-02 (high) | `wait_for_task` при удалении задачи ронял процесс | try/catch в `mcp-host.service.ts` |

## 2. Главное по темам

**Безопасность.** S-01 critical (агенты и оркестратор — один OS-пользователь root). X-NEW-1 high (чат-агент читает токены Codex через `read_document`, одобрения нет, текст из вложения/веб-страницы может заставить его выдать их в чат). X-RUN-1 high (хук одобрений при сбое запуска/таймауте пропускает инструмент). S-02 high (мутации без `@Roles`). S-03 (зависимости: достижимы multer DoS, engine.io DoS, MCP SDK). S-05, S-07, F-07, F-08, X-NEW-3 (загрузка `.links.json` любой ролью подменяет карту ссылок).

**Надёжность.** E-01 (двойной Authorization → fetch падает, worktree от устаревшей ветки), E-02 (600-с таймаут идёт во время `ask_user`/approval), E-03 + X-Q-1/2/3/5 (гонки статусов: отменённая задача перезапускается; два прогона одной задачи; `running` поверх `cancelled`), X-Q-6 (`tick()` без try/catch → `process.exit` на SQLITE_BUSY), X-FO-1 (failover на follow-up отправляет провайдеру B только «да, делай»), C-03/C-06 (Telegram >4096), C-04/C-05 (состояние каналов в памяти; `reload()` → дубли), C-09 (вопросы подзадач — broadcast), F-14 (webm без duration), D-01/D-02, D-03/D-04. Обновление/бэкап: X-DB-1, X-UPD-1…6, X-BAK-1.

**Стоимость и производительность.** X-COST-1 (стоимость при resume — кумулятив SDK, суммируется повторно: Stats завышает квадратично), X-COST-2/3/4 (сабагенты не считаются; отменённые прогоны = 0; бюджет по токенам без кэша), E-04 (кэш промпта — исправление скорректировано), E-05/06/07, E-09/E-10 (≈12 лишних запросов на прогон), E-25 + X-MEM-1 (до 2N рестартов LiteLLM на старте, рвут живые стримы), C-22 (5–6 `statSync` на запрос), дашборд D-26/D-27/D-29/D-31.

### 2a. Новые находки (не было в 01–05)

| ID | Sev | Где | Что | Исправление | Усилие |
|---|---|---|---|---|---|
| X-NEW-1 | **high** | `queue/task-worker.service.ts:282` (chat: `worktreePath = agentDir`), `agent/real-agent-executor.ts:554,589` | `mediaRoots = [ctx.worktreePath, …]`, для чат-задач это весь `agentDir`; `read_document` (без одобрения) читает `runs/<любая задача>/codex-home/auth.json` (живые OAuth-токены ChatGPT на время прогона), `.codex-home/auth.json`, `admin-audit.jsonl`; `workspace_save from=` копирует их в deliverables и ссылкой показывает во вложениях — скачает любой вошедший | для chat-агентов `mediaRoots = [generatedDir]`; в `safePath` и `workspace.save` отказывать `*/auth.json`, `runs/*/codex-home`, `.codex-home` | S |
| X-RUN-1 | **high** | `packages/agent-runner/src/settings.ts:25-31`, `codex.ts:64` | Хук `PreToolUse` без `onFailure: 'block'`: по умолчанию SDK (0.3.295) при невозможности запустить скрипт, таймауте или неверном JSON **пропускает** инструмент. Сейчас маскируется E-12 (таймаут ≈ 3,6 суток); исправление E-12 без этого пункта сделает таймаут хука = allow | `onFailure: 'block'` в обоих местах + E-12 (`timeout` в секундах); тест на `writeAgentSettings` | S |
| X-Q-6 | **high** | `queue/embedded-task-queue.service.ts:76-88` (`tick` → `claimNext` без try/catch, вызывается `void`), `bull-task-queue.service.ts:54` (нет `worker.on('error')`), `main.ts:30-39` (`process.exit(1)` на unhandledRejection) | Одна временная ошибка Prisma (SQLITE_BUSY — см. X-DB-6, X-UPD-6) или Redis-блип гасит весь оркестратор вместе с агентами | try/catch + лог в `tick`; `worker.on('error')`, `queue.on('error')` | S |
| X-Q-1 | high | `tasks.service.ts:444-455, 554`, `real-agent-executor.ts:524` | Нет взаимного исключения по задаче: `followUp` проверяет статус и ставит job неатомарно; `scheduleFollowUp` не проверяет вовсе. При concurrency>1 два job одной задачи идут одновременно: второй абортит первый (`active.get(taskId)?.abort()`), оба в одном worktree, finalize первого пишет `stalled` поверх второго | атомарный `updateMany({where:{id,status:{in:TERMINAL}}, data:{status:'queued'}})`, при `count=0` — в pending; в `process()` пропускать задачу, которая уже `running` | S–M |
| X-Q-2 | high | `task-worker.service.ts:82`; `tasks.service.ts:710,724-726`, `markDone` | `process()` ставит `running` без проверки статуса; `removeForTask` вызывается только для нетерминальных задач, `markDone` — никогда → отложенный `schedule_check` воскрешает `done`/`cancelled` задачу; job, захваченный между `removeForTask` и `setStatus('cancelled')`, переписывает `cancelled` | guarded `updateMany` (не из `cancelled/done`), выход при 0; `removeForTask` в `cancel/markDone/delete` всегда | S |
| X-Q-3 | medium | `task-worker.service.ts:229-270` | `setStatus('review')` сливает follow-up сразу; новый job стартует (`setImmediate`), пока старый `process()` ещё пушит/открывает PR в том же worktree; `finally` старого зовёт `preview.stop(taskId)` и убивает preview нового | drain из `finally` воркера после полного завершения | S |
| X-Q-4 | medium | `bull-task-queue.service.ts:50` | BullMQ по умолчанию (`maxStalledCount=1`) возвращает job упавшего процесса в очередь: после рестарта задача перезапускается с исходным промптом без resume в грязном worktree; контракт `queue.constants.ts:22-24` обещает обратное (embedded ведёт себя правильно) | `maxStalledCount: 0` | S |
| X-Q-5 | medium | `approvals.service.ts:175, 270`; `tasks.service.ts:541-545` | `setStatus('needs_approval')` без guard (= E-35) и approve устаревшего continuation на отменённой задаче перезапускает её | guarded `updateMany(status:'running')`; в `decide` для continuation требовать `needs_approval` | S |
| X-FO-1 | high | `real-agent-executor.ts:235, 388` | Failover на follow-up: `resumeSessionId: undefined`, промпт = только текст follow-up («да, делай») без задачи и истории, в уже изменённом worktree | дешёвый вариант: на follow-up не переключать провайдера, а завершать `stalled` с понятной причиной (X-FO-6); дорогой — `basePrompt` + follow-up + последний summary + пометка «worktree в работе». См. решение №7 | S / M |
| X-FO-4 | medium | `real-agent-executor.ts:392`, `litellm.service.ts:205` | `resolveModelEnv`/`ensureRoute` вне try: HTTP≠2xx или ECONNREFUSED к LiteLLM вылетает из `run()` без failover → задача `failed` | внести в try как failover-worthy | S |
| X-FO-6 | medium | `real-agent-executor.ts:757, 820-830`, `task-worker.service.ts:198-200, 290` | Когда все провайдеры упали, в `task.error` — «run ended abnormally…», текст ошибки провайдера только в логах | `errorText` в `AgentRunOutcome` → `task.error` | S |
| X-FO-7 | medium | `real-agent-executor.ts:171, 1117-1140` | Карта сабагентов строится один раз под провайдера A; после failover `Task` указывает на маршруты A | пересобирать карту на попытку | S |
| X-COST-1 | **high** | `packages/agent-runner/src/run.ts:422`, `real-agent-executor.ts:733`, `usage.ts:28`, `stats.service.ts:43` | `total_cost_usd` в SDK — **кумулятив** по сессии (документация: «a resumed session continues from the total its transcript saved»); каждый follow-up резюмит и сохраняет полную сумму заново, reporting-resume добавляет свой кумулятив; Stats суммирует строки → стоимость растёт ≈ квадратично числу follow-up | хранить дельту (`total − предыдущий total той же claude-сессии`); пересчёт исторических данных не делать, пометить дату | S |
| X-COST-2 | medium | `run.ts:415-424` | `msg.usage` = только главный цикл («MAIN AGENT LOOP ONLY»): токены сабагентов и compaction не в Stats и не в бюджете | суммировать `msg.modelUsage` (заодно стоимость по моделям) | S |
| X-COST-3 | medium | `run.ts:355,434-446`, `real-agent-executor.ts:801-806` | Отменённые/таймаутнувшие/упавшие прогоны пишут 0 токенов; catch-ветка usage не пишет вовсе | писать usage из последнего `modelUsage`/частичных событий | S |
| X-COST-4 | medium | `real-agent-executor.ts:356-366, 222` | Бюджет считает `input+output` без cache-токенов, проверяется один раз до прогона, скользящие 24 ч; «blocked» внутри `verifyWithFixes` игнорируется | бюджет по стоимости (с кэшем), проверка и при resume; календарный день. См. решение №6 | S |
| X-COST-5/6 | low | `codex.ts:353, 279`, `StatsPage.tsx:40` | Codex всегда 0 $ (и для api-key), «—» вместо «free»; `numTurns` у Claude = запросы, у Codex = `turn.completed` | пометки в UI; `numTurns` переименовать в «запросы» только для Claude | S |
| X-RUN-2 | low | `run.ts:385`, `real-agent-executor.ts:461` | stderr Claude не ограничен, каждое событие сбрасывает idle-watchdog (CLI, логирующий ретраи, никогда не упрётся в `AGENT_IDLE_TIMEOUT_MS`) | cap/rate-limit, stderr не считать прогрессом | S |
| X-DB-1 | **high** | `prisma/sqlite/migrations/*`, `infra/minimal-entrypoint.sh:31`, `install.sh:597` | Prisma не оборачивает миграцию в транзакцию; многошаговая (`20261012150100_task_kind`: ADD COLUMN → UPDATE → CREATE INDEX) может остаться наполовину применённой; запись `failed` в `_prisma_migrations` ломает каждый следующий `migrate deploy` (P3009), entrypoint под `set -e` → не стартует ни новая, ни старая версия после `aigentron rollback` | снимок БД перед `migrate deploy` (`VACUUM INTO`), при ошибке — восстановить + `migrate resolve --rolled-back`; SQLite-миграции в `BEGIN/COMMIT` | S |
| X-UPD-1 | **high** | `install.sh:597-599`, `infra/aigentron-cli.sh:206-217` | Обновление мигрирует живую `orchestrator.db` без копии; `rollback` только переключает симлинк и пишет «harmless» | см. X-DB-1; `rollback` восстанавливает снимок | S |
| X-BAK-1 | **high** | весь репозиторий | Бэкапа нет: ни `.backup`/`VACUUM INTO`, ни `pg_dump`, ни tar `secrets/ workspace/ agent/`; документация советует «скопировать /data» — `cp` живого SQLite (без WAL) может дать битую копию | `aigentron backup [dest]` / `restore <file>`: `VACUUM INTO` через better-sqlite3 из node_modules (sqlite3 CLI не установлен) + tar без `worktrees/`, `repo/`, кэшей; хранить N последних; systemd-таймер рядом с `aigentron-update-check.timer`; вызов из install.sh перед миграцией. ≈ 60–80 строк sh | S–M |
| X-UPD-2 | medium | `update-core.ts:56`, `install.sh:439-446`, `aigentron-cli.sh:201,204` | = C-36: установщик и tarball без хэша/подписи исполняются от root; CLI `update` берёт `main/install.sh` без пина | SHA256SUMS в релизе + проверка до `sh`/`tar`; CLI — по тегу | S |
| X-UPD-3 | medium | `update.service.ts:136` | = C-18: `status.json: running` навсегда блокирует `apply()` | «running» старше 30 мин или без живого `aigentron-update-*` юнита = `failed` | S |
| X-UPD-4 | medium | `update-core.ts:57-68`, `install.sh:651` | `ok` пишется по выходу установщика; `systemctl restart` (`Type=simple`) возвращается сразу, `/api/health` не проверяется, авто-отката нет | опрос `/api/health` N с после рестарта; при провале — симлинк назад + снимок + `failed` | S |
| X-UPD-5 | medium | `update.service.ts:107`, `tasks.service.ts:740-750`, `approvals.service.ts:218,424` | `runningTasks()` не считает `needs_approval`; после рестарта такие задачи не реконсилируются (ждун потерян), позднее «Approve» → `resumeTaskIfClear` ставит `running` без агента (та же природа, что C-10); Docker: `docker rm -f` = SIGKILL | reconcile на старте: pending approvals/questions → `timeout`, `needs_approval` → `stalled`; `docker stop -t 60` перед `rm` | S |
| X-UPD-6 | medium | `install.sh:597 → :651` | bare-metal: миграция идёт, пока старый процесс обслуживает запросы (SQLITE_BUSY → X-Q-6; старый код на новой схеме) | stop → снимок → migrate → симлинк → start | S |
| X-UPD-7/8 | low | `update.service.ts:160`, `install.sh:571-577` | `dataDir = dirname(secretsDir)` ломается при своём `SECRETS_DIR`; старые релизы чистятся до сборки | `process.env.DATA_DIR`; prune после health-check | S |
| X-DB-2 | medium | `schema.prisma:274,365,409,517,572` | Удаление задачи оставляет сирот: `AgentQuestion.taskId`, `ChannelChatState.activeTaskId`, `Schedule.taskId` (расписание `same` продолжает слать follow-up удалённой задаче), `ApprovalException.taskId`, `QueueJob.taskId` (только незахваченные) | `deleteMany/updateMany` в `delete()` + одна миграция с `onDelete` (PG + SQLite) | S |
| X-DB-6 | low–medium | `prisma.service.sqlite.ts:29` | Нет `PRAGMA journal_mode=WAL; busy_timeout` — при внешнем писателе и concurrency>1 SQLITE_BUSY (→ X-Q-6) | выставить на connect | S |
| X-DB-3/4/5 | low | `schema.prisma` | нет FK `AuthSession.userId`; нет индексов `Task(parentId, createdAt)` (= E-31), `AgentEvent(taskId, kind, createdAt)` | в ту же миграцию, что X-DB-2 | S |
| X-MEM-1 | medium | `litellm-managed.service.ts:42-45`, `providers.service.ts:54-85` | = E-25, но хуже: старт блокируется до готовности LiteLLM (до 120 с), затем на каждого провайдера `deleteRoutesFor` + `registerRoute` → до 2N рестартов, каждый рвёт живые стримы; лениво добавленные маршруты стираются и вызывают рестарты позже (X-FO-5) | на старте diff желаемых маршрутов с таблицей, один regenerate, рестарт только если YAML изменился | M |
| X-MEM-2…5 | low | `knowledge.service.ts:91,95`, `channel-manager:126`, `task-worker.service.ts:36,66`, `attachments.service.ts:208`, `real-agent-executor.ts:1252` | кэш KB без лимита; per-task Map без выселения; интервал `syncConcurrency` без `unref/clear`; `fileCache` без лимита | LRU/TTL, чистка на settle/delete | S |
| X-BAK-2 | low | `app-config.service.ts:188`, `install.sh:612-628` | bare-metal: `LITELLM_MANAGED_CONFIG_PATH` (ключи провайдеров) по умолчанию `/data/...` — вне `$DATA_DIR` | задать `$DATA_DIR/...` в юните | S |
| X-NEW-2 | medium | `real-agent-executor.ts:586-587`, `media.service.ts:34` | `read_document` включается агенту, которому намеренно убрали `Read`, и даёт весь `attachmentsDir` (все задачи), workspace, библиотеку и worktree | корни: `attachments.dir(taskId)` + ссылки + workspace + библиотека; worktree — нет (= F-09) | S |
| X-NEW-3 | medium | `attachments.controller.ts:16-20`, `attachments.service.ts:306-325` | Загрузка без роли; `sanitize` оставляет ведущую точку → загрузка `.links.json` (пока ссылок нет) подменяет карту ссылок: любое имя указывает на любой файл workspace/библиотеки и показывается как «вложение человека»; `GET …/.links.json` отдаёт абсолютные пути (= F-11) | запрет имён на «.» в `save/sanitize/filePath` | S |
| X-NEW-4 | low–medium | `real-agent-executor.ts:590-596`, `knowledge/extract.ts:17` | каждый вызов `read_document` читает и извлекает файл целиком (до 25 МБ) ради 12 000 символов; PDF парсится в главном потоке, `withTimeout` через `Promise.race` не останавливает работу | кэш текста по (realpath, mtime); лимит 10 МБ; PDF — в worker | S–M |
| X-NEW-5/6/7 | low | `real-agent-executor.ts:856-860`, `attachments.service.ts:231, 306-318` | имена ссылок в промпте расходятся с `list()`; `.links.json` пишется не атомарно; `uniqueName` не знает про ссылки (= F-12) | карта `{имя → путь}` из `list()`; tmp+rename; учёт ссылок | S |
| X-NEW-8 | low | `attachments.service.ts:149-153`, `agent/codex-images.ts:18` | `adopt` следует симлинкам/хардлинкам (`stat/copyFile`), содержимое не проверяется, `nosniff` нет (= F-05) | `lstat` + `nlink===1`; `nosniff` | S |
| X-NEW-9 | low | `channel-manager.service.ts:400` | «заблокированная задача становится активной в чате» проверяет `!prefix`, а не `!task.parentId` — подзадачи и фоновые задачи перехватывают следующее сообщение; `activeTaskId` ставится до успешной отправки | `!task.parentId`; ставить после `send` | S |
| X-CF-1 | medium | `auth-core.ts:161-166`, `auth.controller.ts:30-35` | `TRUSTED_PROXY` — только точные IP, без CIDR: при orange-cloud напрямую в EC2 лимитер входа ключуется по IP Cloudflare-edge (один атакующий блокирует всех на 15 мин; в списке сессий — IP Cloudflare); нет лимита по аккаунту | CIDR (диапазоны Cloudflare в комплекте) + лимит по пользователю | S |
| X-CF-2 | medium | `cloudflare-access.service.ts:62-65`, `access-core.ts:24-30`, `main.ts:96` | Прямой заход на `http://<EIP>:3001` минует Cloudflare Access/WAF: только пароль | security group только для диапазонов Cloudflare или туннель; strict-режим по умолчанию при включённом Access. См. решение №3 | S (doc) |
| X-CF-3 | low | `auth.guard.ts:38` | `isThisMachine` — только по адресу сокета; при `cloudflared` на том же хосте все запросы — с loopback → machine-routes без сессии (остаётся hook secret / bearer) | запрос с `cf-connecting-ip`/`x-forwarded-for` ≠ «эта машина» | S |
| X-CF-4 | medium | `mcp-host.service.ts:418,423` | `wait_for_task` до 600 с без данных в ответе → Cloudflare режет ≈ 100 с (524) | cap 90 с за прокси или heartbeat каждые 30 с | S |
| X-CF-5 | medium | `attachments.service.ts:68`, `api.ts:808-816`, `CreateTaskForm.tsx:66` | сервер принимает 300 МБ видео, Cloudflare free — 100 МБ: 413-HTML показывается сырым; `CreateTaskForm` создаёт задачу до загрузки — задача без файла | лимит из `GET /media` (95 МБ за прокси) + проверка в браузере; chunked-upload — позже. См. решение №8 | S / M |
| X-CF-6 | low | `knowledge/extract.ts:27-29` | загрузка PDF в KB парсится в запросе до 2×60 с → 524 при живой работе | отвечать сразу, прогресс по сокету | S |

**Проверено и в порядке (чтобы не искать снова):** SQLite-схема генерируется из `schema.prisma` без дрейфа; миграции 20261011–20261012 совпадают с Postgres; `migrate deploy` (не `db push`); FK включены в better-sqlite3; индексы `Task.status`, `AgentEvent(sessionId, seq)`, `QueueJob`, `ChannelMessageLink`, `Schedule(enabled, nextRunAt)` есть; один job не захватывается дважды (оба драйвера); понижение concurrency корректно; `wakeIfSubtasksDone`, `resumeTaskIfClear`, `resumeIfClear` с guard; `resolveLink` — realpath внутри workspace/библиотеки, `/etc/passwd`/`secrets/` отказ, протухшие ссылки пропускаются; inline-файлы ≤ 12 000 симв./файл, 24 000 всего; cookie `HttpOnly; SameSite=Lax; Secure` по `X-Forwarded-Proto`; socket.io работает через Cloudflare; approval-wait (до 1 ч) идёт только локально от хука; большинство in-memory структур ограничено, таймеры `unref`.

## 3. Дублирование (что объединить)

Таблица ред. 1 остаётся в силе: `file-types` (8 таблиц mime), `fs-safe` (5 реализаций «внутри корня»), `file-io/serveFile`, один `htmlToText`, реестр имён инструментов (E-14), `adapterFor()`/`destForTask()`, один хук транскрипта, `UploadButton`, стор approvals, `request()` в `api.ts`, одно правило «отдать файл» в SOUL.md. В план попадают только те, что закрывают конкретный баг или нужны для тестов (§5, волна 2).

## 4. Целевая файловая модель (из `03`)

Без изменений: слой 1 — единый FileStore с зонами `inbox` / `library` (бывшие Resources) / `work` / `deliverables` / `memory`; слой 2 — KB как индекс (`sourceRef` + `contentHash`, upsert); слой 3 — память проекта; кэш — один `cache/`. Порядок зависимостей: `fs-safe`/`file-io` (волна 2) → `.digest` в `cache/` → Resources → `library/` → `sourceRef` в KB → проекты.

## 5. План по волнам

### Волна 0 → 0.1.59 (≈ 2–3 дня; без миграций БД, без изменения поведения для владельца)

Пять независимых рабочих потоков, файлы не пересекаются. Внутри потока — порядок как в списке, один коммит на пункт.

| # | Поток | Пункты | Файлы |
|---|---|---|---|
| A1 | **A** маршруты и тесты | S-02 (+ tasks start/follow-up/cancel/delete/pending-follow-ups, attachments upload, update/check): settings/agents/providers/update → `operator, admin`; tasks-мутации и upload → `task_setter, operator, admin` | `settings/settings.controller.ts`, `agent-registry/agent-registry.controller.ts`, `providers/providers.controller.ts`, `tasks/tasks.controller.ts`, `attachments/attachments.controller.ts` (+ F-05 `nosniff`), `update/update.controller.ts` |
| A2 | A | S-05: `timingSafeEqual` + `@Roles('operator','admin')` | `settings/settings.controller.ts` |
| A3 | A | S-09 минимум: unit-тесты `RolesGuard` (сессия vs `x-lds-user`, нет роли → 403), `AuthGuard` (public/machine/mcp-token), smoke «мутация без сессии → 401» по списку S-02 | новые `identity/roles.guard.test.ts`, `auth/auth.guard.test.ts` |
| A4 | A | S-10, S-12: `research-cache` в `.gitignore`/`.dockerignore` + `git rm --cached`; `engines.node >=22` | `.gitignore`, `.dockerignore`, `package.json` |
| A5 | A | S-11: `docs/authentication.md` § маршруты | `docs/authentication.md` |
| B1 | **B** executor / очередь | X-RUN-1 + E-12: `onFailure:'block'`, `timeout` в секундах; тест `writeAgentSettings` | `packages/agent-runner/src/settings.ts`, `codex.ts`, новый `settings.test.ts` |
| B2 | B | X-Q-6: try/catch в `tick`, `worker.on('error')`/`queue.on('error')` | `queue/embedded-task-queue.service.ts`, `queue/bull-task-queue.service.ts` |
| B3 | B | E-03 + X-Q-2: в `cancel()` сначала `deleteMany pendingFollowUp`, `removeForTask` всегда (и в `markDone`/`delete`), затем `setStatus`, затем `executor.cancel`; в `process()` guarded `updateMany` → `running` (не из `cancelled/done`), выход при 0 | `tasks/tasks.service.ts`, `queue/task-worker.service.ts`; тест с фейковым prisma на порядок вызовов |
| B4 | B | X-NEW-1: для chat `mediaRoots = [generatedDir]`; `safePath`/`workspace.save` отказывают `*/auth.json`, `runs/*/codex-home`, `.codex-home` | `agent/real-agent-executor.ts:554`, `media/media.service.ts`, `workspace/workspace.service.ts`; тест на `safePath` |
| B5 | B | E-04 (скорректированный): из `appendSystemPrompt` убрать карту проекта и memory-дайджест, отдавать их в тексте промпта (первый прогон и follow-up); тест на то, что append не зависит от карты | `agent/real-agent-executor.ts:163-177, 217, 388, 1091-1096` |
| B6 | B | E-34/X-FO-2: `prompt`-событие только на первой попытке | `agent/real-agent-executor.ts:517-520` |
| B7 | B | E-01: `authEnv` с reset-записью (`COUNT=2`), общий `worktrees/git-auth.ts` + тест (E-16) | `worktrees/workspace.service.ts`, `worktrees/github.service.ts`, новый `worktrees/git-auth.ts(.test.ts)` |
| C1 | **C** файлы / research / каналы | F-07: `\|\|` в config, `insideRoot` игнорирует пустой корень, `roots.filter(Boolean)`; тест | `config/app-config.service.ts:194`, `media/media-core.ts:175-180`, `media/media.service.ts:34` |
| C2 | C | F-08: `maxOutputLength: 12 MiB`, ловить `ERR_BUFFER_TOO_LARGE` | `research/research.service.ts:179-181` |
| C3 | C | X-NEW-3 + F-11 + X-NEW-6: запрет имён на «.» в `sanitize/save/filePath`; `.links.json` через tmp+rename; тест | `attachments/attachments.service.ts`, `attachments-link.test.ts` |
| C4 | C | C-06: `clip` текста approval (4096, полный текст в дашборде) | `channels/telegram.adapter.ts:159-174` |
| C5 | C | C-09 (минимально): в `onQuestionCreated`/`onApprovalCreated` подъём к родителю как в `:268-273`; X-NEW-9: `!task.parentId` | `channels/channel-manager.service.ts:400, 572-591, 660-679` |
| C6 | C | C-13: `cmd.replace(/@\w+$/, '')` + тест | `channels/channel-commands.service.ts:111-115` |
| D1 | **D** дашборд | D-01/D-02: обёртка `<TaskDetailPage key={id}/>` + сброс черновика по `taskId` | `main.tsx`, `pages/TaskDetailPage.tsx`, `components/FollowUpForm.tsx` |
| D2 | D | D-26: lazy-роуты + `Suspense` с фоновым fallback | `main.tsx` |
| D3 | D | D-27: маскот по `requestIdleCallback`/первому открытию, JSON как `?url` | `components/MascotView.tsx` |
| D4 | D | D-18 (дёшево): убрать блок approvals из `TaskListPage` (остаётся dock) | `pages/TaskListPage.tsx` |
| F1 | **F** infra | X-DB-1/X-UPD-1 (минимум): снимок `VACUUM INTO $DATA_DIR/backups/pre-<version>.db` перед `migrate deploy`; при ошибке — восстановить и выйти с понятным сообщением; `rollback` восстанавливает снимок, если он есть | `install.sh:594-600, 606-617`, `infra/minimal-entrypoint.sh:28-33`, `infra/aigentron-cli.sh:206-217` |
| F2 | F | X-UPD-3/C-18: `running` старше 30 мин = `failed` | `update/update.service.ts:91-102,136`, `update-core.test.ts` |
| F3 | F | `check-admin-skills` проверяет лимит 16 000 символов | `scripts/check-admin-skills.mjs` |
| F4 | F | `docker stop -t 60` перед `rm -f` (часть X-UPD-5) | `install.sh:534` |

Финал волны 0 (один человек): `pnpm test && pnpm lint && pnpm typecheck && pnpm build`; `pnpm --filter @lds/dashboard build` — размер; ручной прогон чек-листа на dev-compose и в minimal-контейнере; `chore(release): 0.1.59`.

**Критерии приёмки 0.1.59**
1. Тесты ≥ 486 + новые (guards, `writeAgentSettings`, `git-auth`, порядок в `cancel`, `insideRoot` с пустым корнем, `sanitize` имён на «.», `safePath` для `auth.json`), lint/typecheck зелёные; основной чанк дашборда ≤ 450 кБ (было 634).
2. Сессия reviewer: `PUT /api/settings`, `POST /api/agents`, `POST /api/providers`, `POST /api/tasks/:id/follow-up` → 403; operator → 200; без сессии при включённом входе → 401.
3. Отмена задачи с непустой очередью follow-up: статус остаётся `cancelled`, очередь пуста, новый job не создан (unit + вручную).
4. Хук: подменить `HOOK_SCRIPT_PATH` на несуществующий → опасный инструмент **блокируется** (вручную, один раз, оба рантайма).
5. E-01: dev-стенд с `repoUrl` + токен, рестарт → в логе нет `fetch failed`, worktree новой задачи на свежем `origin/<branch>`.
6. E-04: на 2-м follow-up задачи в Stats `cacheRead > 0`, input-токены ниже, чем на 1-м (сравнить с 0.1.58 на том же сценарии).
7. Чат-агент: `read_document("<agentDir>/runs/<id>/codex-home/auth.json")` → отказ; обычный файл вложения читается.
8. Telegram: approval с summary 5 000 символов доставляется (обрезан); вопрос подзадачи, порождённой задачей из чата, приходит в чат родителя, а не broadcast.
9. Дашборд: переход родитель → подзадача очищает черновик и staged-файлы; lazy-роуты без пустого мигания; на главной approval-карточки один раз.
10. Обновление: `status.json` с `running` и старым `startedAt` не блокирует `apply`; перед миграцией появляется `$DATA_DIR/backups/pre-0.1.59.db`; `aigentron rollback` на тестовом инстансе восстанавливает его.

**Регрессионный чек-лист (вручную, dev-compose + minimal; 30–40 мин)**: вход/выход; создать задачу из дашборда, follow-up, ответ на `ask_user`, одобрение опасной команды из дашборда и из Telegram; отмена; удаление; вложение с кириллическим именем — загрузка и скачивание; фото с камеры; задача через Codex с картинкой в ответе; запуск расписания; `GET /api/update`; Stats; Workspace: `workspace_save` → ссылка во вложениях; `/tasks@bot` в группе.

### Волна 1 → 0.1.60–0.1.61 (≈ 1,5 недели): надёжность, стоимость, бэкап

Тесты **до** правок: таблица «outcome → status» для воркера (E-33/E-29), `mergeLines` для транскрипта (D-45), `resolveProviderChain`/`isFailoverWorthy` (E-29).

1. **Бэкап и обновление**: X-BAK-1 (`aigentron backup/restore` + таймер), X-UPD-4 (health после рестарта + авто-откат), X-UPD-5 (reconcile `needs_approval`, pending approvals/questions → `timeout` на старте = C-10, C-11-sweeper), X-UPD-6 (stop → снимок → migrate → start), X-UPD-2 (SHA256SUMS), X-UPD-7/8, X-BAK-2.
2. **Одна миграция (PG + SQLite)**: X-DB-2 (`onDelete`), X-DB-3/4/5 + E-31 (индексы), C-04 (`ChannelMessageLink.kind/refId` — только колонки, перенос Map-ов следом). Выходит после F1 волны 0 (снимок уже есть). X-DB-6 (WAL/busy_timeout).
3. **Гонки очереди**: X-Q-1, X-Q-3, X-Q-4, X-Q-5/E-35, E-23, E-32/X-Q-7; `decideStatus` чистой функцией (E-33).
4. **Стоимость/учёт**: X-COST-1 (дельта), X-COST-2 (`modelUsage`), X-COST-3, X-COST-4 (бюджет по стоимости — решение №6), X-COST-5/6 (пометки в Stats); E-05/E-06/E-07; E-09/E-10 (`getLite`, кэш настроек); E-25 + X-MEM-1 (один regenerate на старте); C-22 + C-26 (`SecretJsonFile`); X-RUN-2.
5. **Failover**: E-02 (пауза жёсткого таймаута на ожидание человека), X-FO-1 (решение №7), X-FO-4, X-FO-6 (`errorText` → `task.error`), X-FO-7, E-13.
6. **Каналы**: C-03 (разбиение >4096), C-05 (`reload` по diff + `lastUpdateId` в `Channel.config`, без миграции), C-12 + C-25 (`adapterFor`), C-09 полностью (`destForTask`), C-04 перенос Map-ов на `ChannelMessageLink`, C-16, C-17, C-21, C-07 (таймауты запросов), C-08 (429).
7. **Файлы**: F-14 (webm: ремукс `-c copy` в mp4 при загрузке + фикстура-тест), F-04 (проверка задачи + квота), F-17 (ротация `.versions`), X-NEW-2 (корни `read_document` по задаче = F-09), X-NEW-4 (кэш извлечённого текста, лимит 10 МБ), X-NEW-5/7, X-NEW-8, F-15, F-19, F-22, F-23.
8. **Безопасность/инфра**: S-03 (обновить `@modelcontextprotocol/sdk`, `@nestjs/platform-express`, `socket.io`; `pnpm audit --prod` в CI без падения сборки), S-07 → решение №3, S-04 (bearer для research-mcp), S-08, X-CF-1 (CIDR), X-CF-3, X-CF-4 (heartbeat в `wait_for_task`), X-CF-5 (лимит из `/media` — решение №8), X-CF-6.
9. **Дашборд**: D-03/D-04 через `useTaskStream` (после `mergeLines`), D-06, D-29 (только `useMemo`/`memo(Markdown)`/таймер в дочерний компонент), D-31 (`usePolling`), D-36/D-37, D-10 (убрать `x-lds-user`-обвязку из клиента — сервер её игнорирует при включённом входе), D-46 (`eslint-plugin-react-hooks` в режиме warn).

**Критерии приёмки волны 1**: `aigentron backup` → архив, `restore` на чистом инстансе поднимает задачи/секреты/workspace; обновление с намеренно сломанной миграцией откатывается автоматически; два follow-up подряд в терминальную задачу при `concurrency=2` → один прогон; Stats за день после 5 follow-up одной задачи ≈ сумме дельт (сравнить с биллингом Anthropic ±10 %); таймаут прогона не срабатывает, пока открыт `ask_user` 15 мин; Telegram-ответ 12 000 символов приходит тремя сообщениями; после `reload()` канала нет дублей задач; клип с камеры Chrome читается `look_at`; `pnpm audit --prod` без critical/high в рантайме.

### Волна 2 → 0.1.62+ (≈ 1 неделя, не 2): структура — только то, что окупается

Оставить:
- `agent/run-outcome.ts` (чистые `isFailoverWorthy`, `reportText`, `tag/untagSessionId`, `salvageFinalText`) и `agent/run-watchdogs.ts` (E-02 уже вынуждает) + тесты; остальное разбиение executor'а (E-28 п. 1–5) — **не делать**, пока нет багов, которые оно чинит.
- Каналы: только `ChatDestinationService` (`destForTask`) и `ChannelGateway` (`adapterFor`, разбиение, ретраи) — они уже нужны волне 1; `resolveTarget` (C-24) с табличными тестами (C-28). Разбиение на 9 сервисов и `ButtonAction`/`capabilities` (C-27) — **отложить до начала второго канала (Slack)**.
- `fs-safe` + `file-io` + `file-types` (F-38/39/41) — нужны перед файловой моделью; сначала тесты на симлинки/пустой корень/юникод (F-53/54/55).
- E-14 (реестр имён инструментов — тихая поломка whitelist при добавлении инструмента), E-15, E-17, E-18 — мелко, низкий риск.
- Дашборд: `request()` + `ApiError` (D-15/D-17 ядро) — **без** разнесения `api.ts` на 13 модулей (нулевой эффект на бандл, лишний churn); `UploadButton` (D-16), `useSettingsResource` (D-13/D-19).
- `.digest` → `cache/digests` (F-15/F-16), F-18 (retention вложений, выкл. по умолчанию).
- `platform-admin.service.ts` — **не резать** (нет бага-драйвера).

### Волна 3: модель данных и изоляция

Файловая модель §4 (Resources → `library/`, KB `sourceRef` + upsert, F-25, F-45) · **S-01** (решение №4; при согласии — сразу после волны 1, см. рецепт ниже) · проекты (`docs/plan-projects-workspace.md`) — после файловой модели.

**S-01: самый дешёвый действенный путь.** Оркестратор остаётся root (ничего не мигрировать по правам), агенты — под отдельным uid: в `infra/*.Dockerfile` и `install.sh` создать пользователя `agent`; Claude — через `pathToClaudeCodeExecutable` на обёртку `setpriv --reuid=agent --regid=agent --clear-groups -- node <cli>`, Codex — `spawn(..., {uid, gid})`; `HOME` агента = `runs/<task>/home` (уже есть для Codex); `chmod 700 secrets/`, `0600` для `orchestrator.db` и `.env`; `chown agent` для `runs/<task>`, worktree после создания, `attachments/<task>`; `packages/shared/dist` и скрипт хука — только чтение. Усилие **M** для обоих Docker-профилей (2–3 дня с проверкой), bare-metal — +1 день. Не закрывает: HTTP к `127.0.0.1:3001` (при включённом входе нужна cookie — закрыто), `LDS_HOOK_SECRET` в окружении агента (даёт только `approvals/check|wait`, не решение). Промежуточных мер нет; до S-01 не обещать в документах, что approval gate защищает секреты (сейчас честно).

## 6. Решения, которые нужны от вас (с рекомендацией)

1. **Волна 0 одним релизом 0.1.59?** — Да, в порядке §5; без миграций БД (первая миграция — в 0.1.60, уже со снимком).
2. **S-02 меняет поведение**: reviewer/task_setter теряют правку настроек, агентов, провайдеров; reviewer теряет follow-up/cancel/загрузку вложений (остаётся: смотреть, одобрять, отвечать на вопросы). — Да; ваша учётка operator/admin — ничего не меняется; Telegram-пользователи не затронуты (у них нет API-ролей).
3. **S-07**: вместо привязки к loopback (сломает установку на 80/443 за Cloudflare-DNS) — `install.sh` после старта сам задаёт случайный пароль оператора через `POST /auth/setup` на localhost, печатает его и кладёт в `$DATA_DIR/secrets/initial-password.txt` (0600). Существующие установки не затронуты. **Вопрос**: ваш AWS-инстанс за Cloudflare — через туннель (`cloudflared`) или orange-cloud прямо на 80/443? Если второе — security group должна пускать только диапазоны Cloudflare (X-CF-2), иначе `http://<EIP>:3001` обходит Access.
4. **S-01**: рецепт выше, M для Docker. — Рекомендую сразу после волны 1 (до структурных работ), если агенты с shell работают с чужими репозиториями или веб-источниками (research); иначе — волна 3.
5. **После волны 0**: волна 1 (надёжность, стоимость, бэкап) — да, раньше любых структурных работ.
6. **Бюджет по стоимости с кэшем (X-COST-4)** вместо «input+output токены»: существующие лимиты станут строже (cache-токены сейчас не считаются). — Да, с пересчётом дефолта; подтвердить.
7. **X-FO-1** — поведение при падении провайдера на follow-up: (а) не переключать, завершать `stalled` с текстом ошибки (S, честно) или (б) перезапускать на провайдере B с `basePrompt` + summary (M, иногда «доделывает» не то). — Рекомендую (а).
8. **Cloudflare и видео >100 МБ**: ограничить в UI (95 МБ за прокси, понятное сообщение) сейчас; chunked-upload — только если сценарий с камерой реально упирается. — Рекомендую лимит.
9. **Новое**: `agentInstructions` (E-21) — «дописывается всем» (как обещают UI/доки/admin-инструмент) или «fallback» (как в коде)? — Рекомендую «всем» (одна строка кода), иначе переписать 3 текста.

## 7. Документация

Приведена к 0.1.58 (ред. 1). После волны 0: `docs/authentication.md` § маршрутов (S-11); `README`/`docs/remote-access.md` — пароль ставится установщиком, security group для Cloudflare (X-CF-2); `.env.example` — пометка «`WORKSPACE_DIR` не оставлять пустым» (F-07). После волны 1: `docs/backup.md` (новый: `aigentron backup/restore`, что внутри архива, как восстановить на новом сервере), раздел об обновлении (снимок, откат, health-check), семантика `agentInstructions` (решение №9), Stats — пометка о пересчёте стоимости с даты X-COST-1.
