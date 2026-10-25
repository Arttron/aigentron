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
