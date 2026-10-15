# Проекты и рабочее пространство (дизайн, ревизия 2)

> Статус (v0.1.58): W1 и W2 РЕАЛИЗОВАНЫ и выпущены (0.1.56): `WORKSPACE_DIR`, раскладка, несколько корней записи (`LDS_EXTRA_WRITE_ROOTS`), инструменты `workspace_*`, память в промпте, `ask_user` → decisions (§7); страница `/workspace` (обзор, предпросмотр, скачивание, загрузка в `work/`, удаление, правка брифа, строка `..`), размер в диск-отчёте; вложения-ссылки без копии (`workspace_save`). Проекты — НЕ построены; дизайн проектов (§2–6) — целевой. Следующее по рабочему пространству — файловый менеджер (см. `docs/BACKLOG.md`). Связано: `docs/operating-model.md` (§3.2), `docs/workspace-layout.md`, `docs/request-flow.md`.
> Пометки: **✎** — изменено относительно v1, **＋** — добавлено, **✗** — убрано.

## 1. Что есть сейчас (сверено с кодом, v0.1.55)

| Факт | Где в коде | Поправка к v1 |
|---|---|---|
| **Одна** рабочая папка: `WORKSPACE_REPO_PATH` (`/workspace/repo`, `/data/repo`, `$DATA_DIR/repo`); без `repoUrl` она `git init`-ится с пустым коммитом | `worktrees/workspace.service.ts` | ＋ папка всегда git-репозиторий, даже «пустая» |
| `workspaceSubdir` меняет **только cwd**; граница записи — весь репозиторий | `settings.service.ts: workDir()` | ＋ |
| **Shared-режим**: все задачи в одном checkout, параллелизм принудительно 1 (`SettingsService.concurrency()`); по завершении — `git push` текущей ветки в `origin/<repoBranch>`, если есть URL + токен | `queue/task-worker.service.ts`, `github.service.ts: pushSharedWorkspace` | ＋ авто-push: всё, что агент закоммитил в репозиторий (в т.ч. не-кодовые файлы), уходит на GitHub |
| Код-дефолт `WORKSPACE_SHARED=false`; `true` выставляют профили (compose `environment:`, minimal Dockerfile) | `config/app-config.service.ts` | ＋ |
| **Worktree-режим**: ветка `agent/task-<id>` + worktree в `WORKTREES_ROOT/<taskId>`, затем PR | `worktree.service.ts` | — |
| **Граница записи** = `LDS_WORKSPACE_ROOT` (= worktreePath), **один** корень; проверяется хуком только для `Write/Edit/NotebookEdit` и Codex `apply_patch`. **Bash не проверяется по путям** (только шаблоны: `rm -r`, `git push`, секреты, сеть…). Чтение где угодно свободно, кроме секретных путей | `packages/shared/src/classify.ts`, `infra/hooks/pre-tool-use.mjs` | ＋ ключевой факт: «граница» сегодня — частичная |
| Защищённые пути (запись под подтверждение): `SOUL.md`, `agent/agents/`, `agent/skills/core/`, `builtin/`, `catalog/`, `.snapshots/`, `admin-audit.jsonl`, `.github/`, `.git/`, `.lds/` | `classify.ts: isProtectedPath` | ＋ |
| cwd рабочего агента = репозиторий или подпапка. **Admin** (mode `chat`) работает в `agent/` — инструментов на файлы нет **по его определению**, а не из-за режима. **Участники обсуждения** работают в пустой `agent/runs/<taskId>/discussion/` с `Read/Grep/Glob` (читать могут) | `real-agent-executor.ts`, `discussion.service.ts: scratchDir` | ✎ v1: «чат-агенты работают в `agent/` без файловых инструментов» — неточно |
| Вне проекта: `agent/attachments/<taskId>` (вложения + авто-скриншоты инструментов; удаляются с задачей; запись агента туда — под подтверждение), `agent/runs/<taskId>` (settings.json хука, `codex-home`, scratch обсуждений; 14 дней), `agent/resources` (одна библиотека, фильтр по агентам), БЗ в БД (фильтр по агентам), `agent/skills/learned`, `agent/research-cache` (180 дн.) | `attachments.service.ts`, `maintenance.service.ts` | ✎ `runs/` — служебные файлы платформы, а не «потерянные файлы агента» |
| Сущности «Проект» нет. Ресурсы и БЗ видны по списку **агентов**, расписания создают задачи с агентом, у канала — `defaultAgent`; настройки репозитория/verify-команд/эскалаций — глобальные | `schema.prisma: AppSettings`, `resources.service.ts`, `knowledge.service.ts` | — |
| Для не-кодовой работы «положенного места» нет: без подтверждения агент пишет только в репозиторий; любая другая папка — карточка подтверждения (Write) или незаметная запись через Bash | `classify.ts` | ✎ уточнено |
| Карта проекта в промпте: `git ls-files` в cwd (≤150 файлов списком, иначе счётчики по папкам; не git → пусто). Проектный `SOUL.md` читается из корня репозитория | `real-agent-executor.ts: buildProjectMap, buildInstructions` | ＋ |
| Пути для `look_at`/`show_images`/картинки `ask_user`: вложения, библиотека, worktree | `media.service.ts: safePath` | ＋ |
| Диск: `statfs` папки данных (`dirname(AGENT_DIR)`), отчёт по `runs/`, worktree, вложениям, кэшам, библиотеке | `maintenance/*` | ＋ |
| Роли `operator | reviewer | task_setter | admin` — глобальные, ACL на объекты нет. Схема БД: Postgres — источник, SQLite генерируется; миграции пишутся руками для обеих | `users/*`, `prisma/generate-sqlite-schema.mjs` | ＋ |

## 2. Дизайн

**Проект = папка в известном месте с известной структурой + строка в БД (настройки) + область видимости (ресурсы, БЗ, расписания, канал).** Агенты знают, где что лежит, из короткого блока ориентации; платформа принуждает правила записи хуком, а не просьбой.

### 2.1 Размещение

| Профиль | `PROJECTS_DIR` | Репозиторий проекта `default` |
|---|---|---|
| dev compose | `/workspace/projects` ← bind `${PROJECTS_HOST_PATH:-./projects}` (git-ignored) | `/workspace/repo` (как сейчас, **не переносится**) |
| minimal | `/data/projects` (entrypoint `mkdir -p`) | `/data/repo` |
| bare | `$DATA_DIR/projects` | `$DATA_DIR/repo` |

✎ **Миграция нулевая и без переноса файлов**: `default` («Входящие») получает папку `<PROJECTS_DIR>/default/` со структурой §2.2, но его код остаётся по `WORKSPACE_REPO_PATH` (`Project.repoPath` = абсолютный путь). Новые проекты держат код в `work/`. Один механизм «несколько корней записи» покрывает оба случая и worktree-режим (§2.4). Worktree-режим: `WORKTREES_ROOT/<slug>/<taskId>`.

### 2.2 Структура проекта ✎ (сокращена: 5 папок + 1 файл)

```
<PROJECTS_DIR>/<slug>/
  PROJECT.md      досье: цель, ограничения, критерии, кто решает. Пишет человек; агент — через подтверждение
  memory/         журнал проекта — ТОЛЬКО через project_note (прямая запись под подтверждение)
    decisions.md  questions.md  facts.md  plan.md  status.md
  library/        входящие материалы = ресурсы проекта (загрузки, сохранённые вложения, даташиты); агентам read-only
  work/           свободная зона: git-checkout (code) или черновики/заметки/данные (docs)
  deliverables/   результаты для человека — через project_save (версионируется); прямая запись под подтверждение
  .aigentron/     серверное: project.json (id/slug/kind — для повторного усыновления), library.json (индекс), versions/, trash/
```
✗ `inbox/`, `research/`, `data/`, `.runs/` убраны: `research/`/`data/` → под `work/`; `inbox/` слился с `library/`; `.runs/` остаётся в `agent/runs/` (там settings.json хука и `codex-home` с учётными данными — им не место в папке, куда агент пишет и которую бэкапят).
Для `default` папка `work/` не создаётся (код снаружи, §2.1). `memory/*` — append-only, каждая запись `- YYYY-MM-DD [task <id>] текст`; `status.md` — заменяется целиком.

### 2.3 Модель данных ＋ (Prisma; обе миграции — Postgres и SQLite)

```prisma
model Project {
  id                 String    @id @default(cuid())
  slug               String    @unique          // имя папки, неизменяемое: ^[a-z0-9][a-z0-9-]{1,40}$; 'default' зарезервирован
  name               String
  kind               String    @default("docs") // code | docs — задаёт, провизионится ли work/ как git и действуют ли verify/push
  repoPath           String?                    // null = <dir>/work; абсолютный путь только для усыновлённого default
  repoUrl            String?
  repoBranch         String    @default("main")
  githubToken        String?                    // маскируется в API как в AppSettings
  repoSubdir         String?                    // бывший workspaceSubdir
  isolation          String    @default("shared") // shared | worktree (бывший WORKSPACE_SHARED — теперь на проект)
  verifyCommands     String?
  verifyMaxAttempts  Int       @default(2)
  defaultAgent       String?                    // лид по умолчанию для задач проекта (fallback: AppSettings.defaultAgent)
  notifyChannelId    String?                    // эскалации/уведомления (fallback: AppSettings)
  notifyChatId       String?
  budgetTokensPerDay Int?                       // мягкий бюджет (как BUDGET_TOKENS_PER_DAY, но по проекту)
  diskSoftLimitMb    Int?                       // только предупреждение
  archivedAt         DateTime?
  createdById        String?
  createdAt          DateTime  @default(now())
  updatedAt          DateTime  @updatedAt
  tasks          Task[]
  schedules      Schedule[]
  knowledgeBases KnowledgeBase[]
}
// изменения существующих моделей
Task.projectId          String   // NOT NULL после backfill → default; @@index([projectId, status])
Schedule.projectId      String?  // null = default
KnowledgeBase.projectId String?  // null = глобальная
ChannelChatState.projectId String? // выставляет /project; null = Channel.config.defaultProject или default
```
Ресурсы проекта — не в БД: `library/` + `.aigentron/library.json` (тот же `ResourcesService`, параметризованный корнем). `AppSettings.repoUrl/repoBranch/githubToken/workspaceSubdir/verifyCommands/verifyMaxAttempts` — копируются миграцией в `default` и далее **не читаются** (удаляются следующим релизом); Settings → General «Repository» становится ссылкой на настройки проекта `default`.

### 2.4 Граница и безопасность ✎ (главное изменение)

| Правило | Как принуждается |
|---|---|
| Корни записи задачи: `projectDir` ∪ `repoPath` (∪ worktree в worktree-режиме) | хук получает `LDS_WRITE_ROOTS` (список, `:`), classify `isInside` по любому корню; `LDS_WORKSPACE_ROOT` остаётся первым корнем для совместимости |
| `memory/`, `deliverables/`, `PROJECT.md`, `.aigentron/`, `library/` — прямая запись (`Write/Edit/apply_patch`) → подтверждение | `isProtectedPath` + `LDS_PROJECT_DIR`; штатный путь — инструменты `project_note`/`project_save` (серверные, вне хука) |
| **Bash с абсолютным путём в чужой проект** (`<PROJECTS_DIR>/<не-свой slug>`) → подтверждение | новый шаблон в `DANGEROUS_SHELL_PATTERNS`, параметризованный `LDS_PROJECTS_DIR`/`LDS_PROJECT_DIR`; закрывает `cat > …`, `cp`, `mv`, `cd` |
| **Read/Grep/Glob чужого проекта** → подтверждение («чтение другого проекта») | та же проверка в ветке чтения classify; свой проект, вложения, `agent/skills`, `agent/resources` — свободно |
| Секреты/`.env` внутри проекта — как сейчас (под подтверждение) | без изменений |
| `safePath` для `look_at`/`show_images`/`ask_user.image`: + `projectDir`, `repoPath` | `media.service.ts` |
| Файловый API дашборда: `realpath` внутри `projectDir`, симлинки наружу отвергаются, `.aigentron/` не отдаётся, html/svg/js — только скачивание | как `attachments.controller` |
| verify-команды — в БД (роль operator/admin), не в файле проекта | иначе агент правкой файла получает исполнение команд в контексте оркестратора |
| Push в shared-режиме — только `kind=code` с URL+токеном проекта | `task-worker` |

Остаток риска (существующий, не новый): symlink, созданный через Bash внутри `work/` на секретный путь, обходит текстовую проверку `isSecretPath` при последующем Read. Отдельная задача: хук делает `lstat` цели.

### 2.5 Как агент работает

- **cwd**: `kind=code` → `repoPath/<repoSubdir>` (как сейчас — тесты, git, preview ждут корень кода); `kind=docs` → `work/`. Абсолютные пути остальных папок — в ориентации.
- **Ориентация** (≈20 строк, ~350 токенов; шаблон ниже) + **карта**: `git ls-files` репозитория (как сейчас) или для docs — список `work/` (≤150) + счётчики `library/`, `deliverables/`. Файлы `library/` — через индекс ресурсов (название, описание, путь; проектные первыми, глобальные после; суммарный лимит 25 — как сейчас).
- **Память в промпте**: `PROJECT.md` (≤4 КБ) + `status.md` (≤1.5 КБ) + последние 15 решений + открытые вопросы (≤6 КБ всего); полные файлы агент читает `Read`. Блок памяти ставится **последним** в системный промпт, чтобы статическая часть кэшировалась провайдером.
- **Инструменты** ＋ (внутренний MCP `lds_internal`, без подтверждения, только для задач проекта; участникам обсуждений — только `project_info`/`project_files`):

| Инструмент | Сигнатура | Поведение |
|---|---|---|
| `project_info` | `{}` | имя, kind, пути папок, правила записи, счётчики файлов, выжимка памяти |
| `project_note` | `{kind: 'decision'\|'question'\|'fact'\|'plan'\|'status', text, resolves?}` | дописать датированную запись в `memory/<kind>s.md`; `status` заменяет `status.md`; `resolves` помечает вопрос отвеченным. Лимиты: ≤2 КБ запись, ≤20 за запуск; запись сериализуется по проекту |
| `project_save` | `{path, content?, from?, note?}` | записать/скопировать файл в `deliverables/<path>` (`from` — абсолютный путь вложения или файла из `work/`); существующий → `.aigentron/versions/<path>.<ts>`; ≤50 МБ; `..`/симлинки отвергаются; возвращает абсолютный путь |
| `project_files` | `{dir?: 'library'\|'deliverables'\|'work'\|'memory', glob?, limit?}` | список с размерами/датами (для админа и дешёвой навигации) |
| admin: `projects_list` `{}`; `project_report` `{slug}`; `propose_project` `{name, slug?, kind, repoUrl?, repoBranch?, pack?, defaultAgent?}`; `propose_project_change` `{slug, patch}` | — | чтение свободно, изменения — карточка подтверждения; `propose_task` получает `project?` |

- Ответы на `ask_user` задач проекта сервер сам дописывает в `decisions.md` (`[ask_user] вопрос → ответ`).
- Подзадачи и Task-субагенты наследуют проект лида; `create_subtask` проект не меняет. ✗ Инструмент «прочитать чужой проект» не вводим: обычный `Read` по абсолютному пути → карточка подтверждения (§2.4).
- Шаблон ориентации (вместо «Your workspace»):
```
## Project: <name> (<slug>, <kind>)
- code (cwd): /…/work            — your repo; git branch <b>; verify: <cmds|none>
- library/: /…/library           — input material (read-only; listed below as resources)
- work/: /…/work                 — drafts, notes, data (free to write)
- deliverables/: /…/deliverables — results for the person: use project_save (direct writes need approval)
- memory/: /…/memory             — decisions/questions/facts/plan/status: use project_note (direct writes need approval)
- PROJECT.md: /…/PROJECT.md      — the brief (read it; changes need approval)
Other projects live under /…/projects/ — reading or writing them needs approval. Attachments of this task: /…/attachments/<id>.
```

### 2.6 Параллелизм и изоляция ✎

- `Project.isolation = shared`: **блокировка на проект** (in-process FIFO-мьютекс в `TaskWorkerService`; оркестратор — один процесс в обоих драйверах очереди). Глобальный `concurrency` больше не прижимается к 1; задача ждёт мьютекс своего проекта, задачи разных проектов идут параллельно. Лид не держит блокировку, пока ждёт подзадачи (его запуск завершён, `awaitingSubtasks`). Ожидание занимает слот — допустимо (взаимной блокировки нет: держатель слот уже имеет).
- `isolation = worktree`: как сейчас, но на проект: worktree из `repoPath`, корни записи = worktree ∪ `projectDir` (без `work/`), PR на задачу. Не-кодовые папки общие без блокировки: `memory/` пишется сервером (сериализовано), `deliverables/` — версионируется `project_save`, `work/` в этом режиме агенту не виден (он в worktree).
- `WORKSPACE_SHARED` остаётся как значение `isolation` по умолчанию для `default` и новых проектов.

### 2.7 Область видимости: ресурсы, БЗ, расписания, каналы ＋

| Что | Модель | Поведение |
|---|---|---|
| Ресурсы | глобальная библиотека `agent/resources` + проектная `library/` | индекс в промпте: проектные → глобальные; `resources_search` ищет по обеим (проектные выше); фильтр по агентам сохраняется; файлы, положенные в `library/` руками, индексируются при сканировании (title = имя файла, описание пустое — дашборд подсвечивает «без описания») |
| Базы знаний | `KnowledgeBase.projectId?` | агент видит глобальные + своего проекта; `kb_search` без `kb` = объединение (RRF уже есть); `kb_add` — только в базы проекта/глобальные с `agentWrite` |
| Расписания | `Schedule.projectId?` | созданные задачи получают проект; пакеты ставят расписания в проект, куда установлены |
| Каналы | `ChannelChatState.projectId`, `Channel.config.defaultProject` | `/project <slug>` и `/project` (показать/выбрать кнопками); новые задачи из чата — в проект чата; эскалации — `Project.notifyChannelId` → `AppSettings` |
| Пакеты | `install(pack, {project})` | агенты и навыки — по-прежнему глобальные (имена уникальны); ресурсы — в `library/` проекта; расписания — в проект; `defaultAgent` проекта = лид пакета |
| Бюджет/статистика | `Project.budgetTokensPerDay` | `checkBudget` суммирует сессии задач проекта; Stats — фильтр по проекту |

### 2.8 Дашборд и API ＋

**Страницы**: `/projects` (карточки: имя, kind, задач активных/на проверке, размер, активность; «New project»: имя, kind, репозиторий, пакет, лид) · `/projects/:slug` с вкладками **Overview** (PROJECT.md — редактор; status; открытые вопросы; последние решения), **Files** (дерево; предпросмотр md/txt/csv/изображений/PDF; скачивание; загрузка только в `library/` и, для docs, в `work/`; удаление в `library/`/`deliverables/`/`work/` с подтверждением; `deliverables/` сверху), **Tasks** (список с фильтром), **Settings** (репозиторий, подпапка, verify, isolation, лид, канал, бюджет, лимит диска, БЗ проекта, Archive/Delete) · список задач: чип «проект» + группировка; «New task»: выбор проекта (запоминается в localStorage) · страница задачи: бейдж проекта; у вложения — «Save to project library» · Resources/Knowledge: переключатель «Global | <проект>» · Settings → General: раздел Repository → ссылка на проект `default`.

**API** (роль в скобках; `task_setter`/`reviewer` — только чтение проектов):
`GET /api/projects` · `POST /api/projects` (operator/admin) `{name, slug?, kind, repoUrl?, repoBranch?, repoSubdir?, githubToken?, pack?, defaultAgent?}` · `GET /api/projects/:slug` · `PATCH /api/projects/:slug` · `POST …/archive` · `DELETE /api/projects/:slug {tasks:'move'|'delete', knowledge:'keep'|'delete'}` · `GET …/files?path=` (дерево/список) · `GET …/files/raw?path=` · `PUT …/files?path=` (raw body + `x-filename`; только `library/`, `work/`, `PROJECT.md`) · `DELETE …/files?path=` · `GET …/memory` (выжимка) · `POST …/memory/notes {kind, text}` · `GET …/report` (размер, задачи, активность) · `POST /api/tasks` + `project?` · `GET /api/tasks?project=` · `PATCH /api/tasks/:id {project}` (перенос; только терминальные статусы; сбрасывает `worktreePath/branch`) · `POST /api/tasks/:id/attachments/:name/save-to-project` · `GET/POST /api/resources?project=` · `POST/PATCH /api/knowledge … {project}` · `Schedule.project` · MCP-хост: `create_task(project?)`, `list_projects` · `GET /api/maintenance/report` + `projects[]`.

### 2.9 Обслуживание, бэкап, удаление ✎

- Диск: отчёт по проектам (`du`, кэш 6 ч); `diskSoftLimitMb` → баннер + строка в ориентации («проект превысил бюджет места — не добавляй большие файлы»). Автоматически удаляется только `.aigentron/versions/` старше `PROJECT_VERSIONS_RETENTION_DAYS` (90) и `.aigentron/trash/` по явной команде. `memory/`, `library/`, `deliverables/`, `work/` — **никогда**.
- Бэкап: `<PROJECTS_DIR>` целиком + БД (строки `Project`) + для `default` — `WORKSPACE_REPO_PATH`. Вложения остаются в `agent/attachments` (как сейчас). Восстановление без БД: на старте сервер сканирует `PROJECTS_DIR`, усыновляет папки с `.aigentron/project.json` (создаёт строку), помечает строки без папки `missingDir` (задачи таких проектов не запускаются, баннер).
- Удаление: только без активных задач; папка → `<PROJECTS_DIR>/.trash/<slug>-<ts>` (не `rm`); задачи → `default` или удаление; БЗ → глобальные или удаление. `default` удалить/архивировать нельзя, переименовать (display name) можно; slug неизменяем у всех.

### 2.10 Миграция существующих установок ＋

1. Миграция БД (Postgres + SQLite): таблица `Project`; строка `default` из `AppSettings` (repoUrl/branch/token/subdir/verify*/notify*, `isolation` из env, `repoPath = WORKSPACE_REPO_PATH`); `Task.projectId` backfill = default → NOT NULL; `Schedule/KnowledgeBase/ChannelChatState.projectId` = NULL.
2. На старте `ProjectsService.ensureLayout('default')` создаёт папку и `.aigentron/project.json`. Файлы не переносятся; worktree и ветки старых задач остаются валидными.
3. Откат: `prisma migrate` назад — файлы в `PROJECTS_DIR` безвредны.

### 2.11 Этапы

| Этап | Содержимое |
|---|---|
| P1 | модель + миграция + `default`; `PROJECTS_DIR`; корни записи и защита (`classify`, хук, `safePath`); ориентация + память + `project_note/save/info/files`; `ask_user` → decisions; проект в задачах/подзадачах |
| P2 | страницы Projects/Files; `project` в New task/фильтрах/Telegram; ресурсы и БЗ по проекту; расписания/каналы/пакеты по проекту |
| P3 | блокировка на проект + `isolation` на проект, worktree под `<slug>/`; verify/push per project |
| P4 | отчёт по диску/бюджет/статистика по проекту; корзина; усыновление папок при восстановлении |

## 3. Ответы на открытые вопросы v1

1. **`work/` или корень?** → `work/` для новых code-проектов, `repoPath` = старый путь для `default` (ничего не ломаем). cwd = корень кода (+подпапка): verify, preview, git работают как сейчас; worktree — из `repoPath`. Нужны **несколько корней записи** в хуке — без этого ни worktree-режим, ни `default` не работают с папкой проекта.
2. **Вложения** → остаются в `agent/attachments/<taskId>` (привязаны к сообщению, скриншоты, удаление с задачей, задачи без проекта не существуют — у всех `default`). В проект попадает только то, что сохранили явно: агент `project_save {from}`, человек «Save to project library».
3. **Блокировка на проект** → достаточна для shared; параллельность внутри одного проекта — только `isolation=worktree` на проект. Общие не-кодовые папки защищены сериализацией `project_note` и версионированием `project_save`.
4. **Ресурсы/БЗ** → глобальные + проектные; ресурсы проекта — файлы `library/` с индексом в `.aigentron/`, БЗ — `projectId` в БД; при поиске проектные выше, запись `kb_add` — только в доступные базы.
5. **git для docs-проектов** → нет. Журналы append-only, результаты версионирует `project_save`, вложенные репозитории путают карту и защиту `.git/`. Опция «git для docs» — позже, если попросят.
6. **Minimal/bare** → `PROJECTS_DIR` рядом с `repo`/`agent` на том же диске (`/data/projects`, `$DATA_DIR/projects`), создаёт entrypoint тем же uid; диск-монитор уже смотрит этот диск; отчёт по проектам — `du` с кэшем.
7. **Дёшево по токенам** → фиксированный блок ≈20 строк с абсолютными путями и правилом записи на папку; списки файлов не перечисляются (счётчики + `project_files`); память ≤6 КБ последним блоком (кэш промпта).
8. **default при удалении/переносе** → `default` неудаляем; удаление проекта переводит задачи в `default` или удаляет их; папка — в корзину; перенос задачи = смена `projectId` у терминальной задачи со сбросом worktree-полей; переименование — только display name.

## 4. Чего сознательно НЕ делаем

- Не переносим существующий репозиторий, вложения и `runs/`; `.runs/` в проекте нет.
- Нет git/автокоммитов в docs-проектах; нет вложенных проектов; slug не переименовывается.
- Нет прав на уровне проекта (все роли видят все проекты); нет приватных проектов.
- Нет инструмента межпроектного чтения/поиска — только `Read` под подтверждение.
- Агенты, навыки (в т.ч. learned) и MCP-серверы остаются глобальными; «команда проекта» = лид по умолчанию + пакет.
- Нет синхронизации с внешними папками/облаками, нет авто-суммаризации `memory/` (консолидация — отдельной плановой задачей позже).
- Нет жёсткого лимита диска на проект (только предупреждение) и нет квот по пользователям.
- Verify-команды и настройки проекта не хранятся в файле проекта (только экспорт `project.json`, read-only).

## 5. Главные риски

1. **Хук с одним корнем и Bash без проверки путей** — без изменений в `classify.ts`/хуке «изоляция проектов» будет декларацией. P1 обязателен до UI.
2. **Миграция `Task.projectId NOT NULL` на SQLite** — пересборка таблицы; тест на живой базе minimal-профиля.
3. **Авто-push shared-режима** — docs-проекты должны его обходить; у `default` с токеном поведение не меняется (документировать).
4. **Рост промпта** — память + индекс проектной библиотеки; лимиты в §2.5 и порядок блоков для кэша.
5. **Двойное место правды для `default`** (AppSettings ↔ Project) на переходный релиз — читать только из `Project`, UI Settings ведёт в проект.

## 6. План реализации (2026-10-12)

Принцип: каждый шаг выпускается отдельно, не ломает существующие установки и полезен сам по себе. Порядок — от защиты и данных к интерфейсу. Размер: S ≈ день, M ≈ 2–3 дня, L ≈ неделя.

### Шаг 0. Подготовка границы (до любых проектов) — M
Без этого «изоляция проектов» декларативна (риск №1), а сам шаг безопасен и полезен уже сейчас.
- `packages/shared/src/classify.ts`: поддержка **списка корней записи** (`LDS_WRITE_ROOTS`, `:`), `LDS_WORKSPACE_ROOT` остаётся первым; `isProtectedPath` + `LDS_PROJECT_DIR`; шаблон в `DANGEROUS_SHELL_PATTERNS` на абсолютный путь в чужой проект и чтение чужого проекта (`LDS_PROJECTS_DIR`).
- Хук (`hooks`/PreToolUse) и executor передают переменные окружения; `safePath` в `media.service.ts` принимает несколько корней.
- Тесты: матрица путей (свой/чужой проект, `..`, симлинк, абсолютный путь в Bash, worktree-режим); регрессия «один корень» = поведение как сейчас.
- Критерий: при одном корне ничего не меняется; все существующие тесты зелёные.

### Шаг 1 (P1). Данные и ядро — L
1. Prisma: `Project`, `Task.projectId` (backfill → `default`, NOT NULL), nullable `projectId` у `Schedule`/`KnowledgeBase`/`ChannelChatState`; **две миграции** (Postgres и SQLite с пересборкой таблицы; проверить на живой минимальной базе, риск №2).
2. `ProjectsService`: `ensureLayout`, создание папок по шаблону (`memory/`, `library/`, `work/`, `deliverables/`, `.aigentron/`), `default` усыновляет `WORKSPACE_REPO_PATH` без копирования; `PROJECTS_DIR` в `AppConfig` для трёх профилей (dev compose, minimal, bare-metal) + entrypoint/installer создают папку тем же uid.
3. Настройки репозитория `default` копируются из `AppSettings`; чтение — только из `Project` (риск №5); `settings.workDir()` и `workspaceConfig()` переводятся на проект задачи.
4. Executor: проект задачи → cwd/корни записи/ориентация (шаблон §2.5) + блок памяти последним; подзадачи наследуют проект.
5. Инструменты `lds_internal`: `project_info`, `project_note`, `project_save`, `project_files` (+ ограничения для участников обсуждений); автозапись `ask_user` → `decisions.md`; запись `memory/` сериализуется по проекту.
6. `POST /api/tasks` принимает `project?`; MCP `create_task(project?)`, `list_projects`.
- Критерий: существующая установка после обновления работает идентично (задачи идут в `default`); задача в новом docs-проекте пишет заметки и сохраняет результат; запись в чужой проект даёт карточку подтверждения.

### Шаг 2 (P2). Интерфейс и привязки — L
- Страницы `/projects`, `/projects/:slug` (Overview, Files, Tasks, Settings), файловый API (`realpath`, запрет симлинков наружу, `.aigentron/` не отдаётся, html/svg/js — только скачивание); загрузка в `library/`.
- «New task» с выбором проекта (запоминается), чип/группировка по проекту в списке задач, бейдж на странице задачи, «Save to project library» у вложения.
- Ресурсы и БЗ: переключатель «Global | проект», индекс в промпте (проектные первыми), `kb_search` по объединению.
- Расписания и пакеты — в проект; Telegram `/project` (кнопки), проект по умолчанию на чат.
- Админ: `projects_list`, `project_report`, `propose_project`, `propose_project_change`; обновить `agent/skills/core/admin/*.md` и `make check-admin-skills`.

### Шаг 3 (P3). Параллелизм и репозитории — M
- Блокировка на проект (FIFO-мьютекс в `TaskWorkerService`), глобальный `concurrency` перестаёт прижиматься к 1; лид не держит блокировку при ожидании подзадач.
- `isolation` на проект (shared/worktree), worktree из `repoPath`; verify и push на проект; авто-push только для `kind=code` с URL+токеном (риск №3).

### Шаг 4 (P4). Эксплуатация — M
- Отчёт по диску и бюджет токенов на проект, фильтр проекта в Stats; `diskSoftLimitMb`.
- Корзина `.trash/`, архив/удаление проекта (задачи → `default`/удалить), перенос терминальной задачи между проектами.
- Усыновление папок при восстановлении без БД, `missingDir`; бэкап-документация.

### Сквозное (в каждом шаге)
- Тесты (vitest): ядро путей, миграции, сервис проектов, инструменты; живая проверка на dev-стенде и на minimal-образе.
- Документация: `docs/workspace-layout.md`, `docs/request-flow.md` (что в контексте), `docs/operating-model.md` (статус), `docs/BACKLOG.md`, admin knowledge, release notes.
- Ревью Fable после шагов 1 и 3 (безопасность границы, миграции).

### Зависимости и порядок
`0 → 1 → 2`; шаг 3 можно делать параллельно с 2 после 1; шаг 4 — последним. Минимально полезный релиз — **шаги 0+1** (проекты в API/MCP/админе, агенты знают структуру и память), интерфейс — следующим релизом.

### Решения, которые нужны от вас до старта
1. Тип по умолчанию для нового проекта: `docs` (как в дизайне) или спрашивать при создании?
2. Видимость проектов для ролей: сейчас «все роли видят все проекты» — достаточно?
3. Выпускать шаги 0+1 без интерфейса (управление через админа и API) или ждать шаг 2?

## 7. Решение (2026-10-12): сначала одно рабочее пространство по умолчанию, проекты — позже

Проектов (сущности, выбора, изоляции) пока нет. Есть одно рабочее пространство со стандартной структурой папок, которое знают агенты. Дизайн §2 остаётся целевым: позже каждый проект — это такая же папка (та же структура), поэтому ничего не переделывается.

### 7.1 Что делаем
- **Корень** `WORKSPACE_DIR` (по умолчанию рядом с `repo`/`agent`: `/data/workspace`, `$DATA_DIR/workspace`, в dev compose — bind-mount хостовой `./workspace`, `WORKSPACE_HOST_PATH`). Создаётся оркестратором при старте, настроек нет.
- **Структура** (создаётся один раз, ничего не перезаписывается):
```
workspace/
  WORKSPACE.md     # краткое досье: цель, ограничения, кто решает (человек правит, агенты читают)
  memory/          # decisions.md, questions.md, facts.md, status.md — через инструмент workspace_note
  work/            # черновики, заметки, данные (свободная запись)
  deliverables/    # готовые результаты для человека — через workspace_save (с версиями)
```
- **Код не трогаем**: репозиторий остаётся на `WORKSPACE_REPO_PATH`, cwd агента и git-поведение прежние. Папка пространства — дополнительный корень записи рядом с ним. Ресурсы и базы знаний остаются глобальными (отдельной `library/` пока нет).
- **Агенты**: в ориентацию добавляется блок ≈10 строк (абсолютные пути, что куда класть) + выжимка `WORKSPACE.md` и `memory/` (≤6 КБ, последним блоком). Инструменты `lds_internal`: `workspace_info`, `workspace_note {kind, text}`, `workspace_save {path, content|from, note?}`, `workspace_files {dir?, glob?}` (участникам обсуждений — только info/files). Ответы `ask_user` дописываются в `decisions.md`.
- **Граница**: список корней записи в хуке (шаг 0 плана §6) — `repo ∪ workspace`; остальное без изменений. Cross-project правила не нужны.
- **Данные**: **без изменений БД и миграций**. Подзадачи видят то же пространство.
- **Человек**: страница `/workspace` (W2, сделано): обзор, предпросмотр, скачивание, загрузка в `work/`, удаление, правка брифа. Дальше — файловый менеджер (BACKLOG).
- **Обслуживание**: диск-монитор показывает размер пространства; автоуборки нет; бэкап — одна папка.

### 7.2 Что переносится в «позже» (проекты)
Сущность `Project`, `projectId` у задач/расписаний/БЗ, выбор проекта, блокировки на проект, изоляция между проектами, проектные ресурсы/БЗ, страницы Projects. Шаги 1–4 §6 остаются планом на этот случай; шаг 0 (границы) выполняется сейчас как часть п. 7.1.

### 7.3 Этапы
| Этап | Содержимое | Размер |
|---|---|---|
| W1 ✅ | `WORKSPACE_DIR` + раскладка; несколько корней записи в `classify`/хуке/`safePath`; блок в ориентации; 4 инструмента; `ask_user` → `decisions.md`; docs/admin knowledge | M |
| W2 ✅ | страница `/workspace` (список с папками, предпросмотр, скачивание, загрузка в `work/`, удаление, правка брифа); размер в диск-мониторе. Админ-инструмента `workspace_report` нет (админ пользуется `workspace_files`/`read_document`) | S–M |
