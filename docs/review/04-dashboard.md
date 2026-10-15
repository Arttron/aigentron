# Ревью дашборда (apps/dashboard/src) — 2026-10-15

Объём: 17.9k строк, 239 модулей. Код не менялся. «Проверено» = воспроизведено чтением кода/grep/сборкой; «не проверено» = гипотеза, нужен прогон в браузере. Линтер в репо без `eslint-plugin-react-hooks` (только `eslint:recommended` + tseslint), поэтому пропущенные deps в хуках никто не ловит (D-46).

Шкала: severity H/M/L; effort S (<2ч) / M (полдня) / L (день+); risk = риск регрессии.

## 1. Таблица находок

### Баги (стейт, гонки, websocket)

| ID | Sev | Вид | Где | Что | Исправление | Effort | Risk |
|---|---|---|---|---|---|---|---|
| D-01 | H | bug | `pages/TaskDetailPage.tsx:38-189`, `main.tsx:29` | Переход `/tasks/A` -> `/tasks/B` (ссылки parent/subtask в `TaskRelations.tsx:66,91,142`) переиспользует компонент: `task`, `lines`, `error`, `debug`, `assetTick`, `activityAt` остаются от A до прихода ответов B; `error` не сбрасывается никогда. `refreshTask` (стр. 75) не защищён флагом `active` — запоздавший ответ A перезапишет B. Проверено по коду. | Рендерить `<TaskDetailPage key={id}/>` (обёртка с `useParams`) — снимает всё разом; плюс AbortController/`active` в `refreshTask`. | S | низкий |
| D-02 | H | bug | `components/FollowUpForm.tsx:73-83` (+ `TaskDetailPage`) | Черновик (`text`, `staged`, `references`) и `queue` не сбрасываются при смене `taskId`. `staged` — это имена файлов, загруженных в каталог задачи A; отправка в B уйдёт с чужими вложениями. Проверено по коду, на UI не воспроизводил. | Лечится D-01 (key); дополнительно `useEffect(() => clearComposer(), [taskId])`. | S | низкий |
| D-03 | H | bug | `TaskDetailPage.tsx:109-130` и `AdminChat.tsx:105-120` | Гонка fetch/сокет: подписка на `agentLog` идёт до ответа `transcript`, а по ответу делается `setLines(initial)` + `seen = new Set()` — живые строки, пришедшие в промежутке, затираются (и их ключи забыты). Проверено по коду. | Мерж: `setLines(prev => mergeByKey(initial, prev))`, `seen` не обнулять; либо буферизовать сокет до ответа. Общий хук `useTranscript(taskId)` (см. D-20). | M | средний |
| D-04 | H | bug | `TaskDetailPage.tsx:136`, `AdminChat.tsx:123` | После реконнекта сокета выполняется только повторный `subscribe`; события, пропущенные за время обрыва, не догружаются (нет refetch transcript/task). Живой лог «молча» теряет куски. Проверено по коду. | В `onConnect`, кроме subscribe, делать refetch transcript+task (идемпотентно благодаря dedupe по ключу). То же в `TaskListPage`, `ApprovalDock` (после реконнекта списки approvals/questions не пересинхронизируются). | M | низкий |
| D-05 | M | bug | `AdminChat.tsx:213-260` | `pendingApprovals` ведётся инкрементом/декрементом по событиям без дедупликации и без ресинка: `approvalCreated` дважды (реконнект) или удаление задачи (каскад без `approvalResolved`, см. комментарий в `ApprovalDock.tsx:58`) -> счётчик уходит; после реконнекта не пересчитывается. `activeTasks` инициализируется только первыми 100 задачами. | Не считать самому: брать `approvals.length` из общего стора (D-18). | S | низкий |
| D-06 | M | bug | `pages/TaskListPage.tsx:76-86,120-150` | На любое `taskUpserted/taskStatus/taskDeleted` (глобальная комната, каждый агент шлёт часто) выполняется 3 запроса (`listTasks` + 2 счётчика) без троттлинга и без защиты от out-of-order: медленный старый ответ перезапишет новый список. `error` не очищается после успешной загрузки. Проверено по коду; нагрузку не мерил. | Коалесцировать (trailing throttle ~1 с), `AbortController`/счётчик запросов, `setError(null)` в успехе; счётчики дёргать реже (раз в N с). | S | низкий |
| D-07 | M | bug | `components/TaskReferencePicker.tsx:31-47,84` | Поиск без защиты от out-of-order ответов; `setTimeout(..., 150)` в `onBlur` без очистки (setState после unmount) и как хак ради клика по пункту. | Флаг `live` в эффекте; пункты на `onMouseDown={e=>e.preventDefault()}` вместо таймера. | S | низкий |
| D-08 | M | bug | `pages/KnowledgePage.tsx:62-67` | `loadDocs(current)`: при быстром переключении баз ответ предыдущей может перезаписать `docs` текущей (нет guard'а), в отличие от `preview` (стр. 134), где он есть. | Guard/abort. | S | низкий |
| D-09 | M | bug | `components/ApprovalCard.tsx:~488` (`UndoPreview`) | При пустом `changeId` эффект выходит без `setE(null)` — вечное «…». `TaskActionPreview` берёт `ids` вне deps (стабильность массива не гарантирована) — не проверено, может перезапрашивать на каждый рендер. | `setE(null)` в ветке без id; ключ-строка в deps. | S | низкий |
| D-10 | M | bug | `lib/api.ts:508,533,550,558,605,624,659-694,746,798,856,872`; `lib/auth.ts` | Заголовок `x-lds-user` (`authHeaders`) подставляется только в ~16 из ~80 вызовов; в остальных POST'ах (markTaskDone, cancel, run schedule, conclude discussion и т.д.) его нет. Если сервер ещё читает его для атрибуции — действия записываются на дефолтного оператора. Но при сессионной авторизации (cookie, `installAuthFetch`) заголовок, возможно, уже мёртв (`UserSwitcher`, `getActingUserId`). Не проверено на сервере. | Выяснить, нужен ли `x-lds-user`; если нет — удалить `authHeaders/jsonHeaders/UserSwitcher`-механику, если да — централизовать в одном `request()` (D-15). | M | средний |
| D-11 | L | bug | `components/AuthGate.tsx:~128-133` | При ошибке `/auth/status` фолбэк `authenticated: true` — UI показывает приложение при недоступном/упавшем статусе (сервер всё равно режет, но получается пустой UI с 401). | Показывать экран «нет связи с сервером» + retry. | S | низкий |
| D-12 | L | bug | `components/ui/Modal.tsx:17-24` | Слушатель Escape переподписывается на каждый рендер (`onClose` в deps — inline-функции во всех вызовах); вложенные модалки (MediaViewer в Modal, `MediaViewer.tsx:44` ставит свой keydown) закрываются все разом по одному Esc. Клик-выделение текста, закончившееся на backdrop, закрывает диалог (используется `onClick`, а не `onMouseDown`-start). | `onCloseRef`, стек модалок, закрытие по `mousedown` target===currentTarget. | S | низкий |
| D-13 | L | bug | `components/settings/{Access,CloudflareAccess,WebServer,Update,Sessions}Settings.tsx` | `load()` без guard'а размонтирования (`setState` после unmount, гонка при быстром переключении вкладок); карточка возвращает `null` пока нет данных (`if (!info) return null`) — вкладка «General» подпрыгивает по высоте 8 раз по мере загрузки карточек. | Общий хук `useSettingsResource` (D-19) + скелетон/`min-height`. | M | низкий |
| D-14 | L | bug | `Transcript.tsx:152-163` | `rise()`/`Date.now()` вызываются и мутируют `useRef` прямо в рендере (нечистый рендер; в StrictMode двойной вызов; `known` растёт без границ). | Пометка «новое» при добавлении строки в стейт (в `addLine`), а не в рендере. | S | низкий |

### Дубли

| ID | Sev | Вид | Где | Что | Исправление | Effort | Risk |
|---|---|---|---|---|---|---|---|
| D-15 | H | dup | `lib/api.ts` (934 строки, 299 методов), `lib/auth.ts`, `lib/voice.ts:14-70`, 5 settings-компонентов, `SecretLinkPage.tsx` | 41 раз `fetch(...,{cache:'no-store'}).then(unwrap<T>)`, 41 раз POST/PUT/DELETE с `method/headers/JSON.stringify`; три разных «обёртки» (`unwrap`, `post`/`send` в auth.ts, `.catch(()=>null)` в settings); 6 компонентов вообще минуют `api` и делают голый `fetch`. Заголовки то `jsonHeaders`, то `authHeaders(true)`. | Один `request<T>(method, path, {query, body, signal})` с единой обработкой ошибок/401/заголовков; методы сжимаются до однострочников. **Разделение api.ts** — см. раздел 3. | L | средний |
| D-16 | M | dup | `ResourcesPage.tsx:58-72,115-140`, `WorkspacePage.tsx:65-77,142`, `KnowledgePage.tsx:95-107,201-235`, `Attachments.tsx`, `FollowUpForm.tsx:275-284`, `CreateTaskForm.tsx:128-139` | Шесть реализаций «кнопка загрузки + скрытый `<input type=file>` + drop-зона + busy/error + сброс `input.value`». Различаются только вызовом API. | Компонент `<UploadButton/>` + хук `useFileDrop(onFiles)` в `components/ui`. | M | низкий |
| D-17 | M | dup | `ResourcesPage.tsx:56`, `WorkspacePage.tsx:35`, `KnowledgePage.tsx:21` | Одна и та же `replace(/^\d+ [^—]*— /,'')` для очистки текста ошибки — три копии, и `(e as Error).message` ещё в ~70 местах. | `ApiError` с полем `message` (чистым) и `status` из `request()` (D-15); `errMsg(e)` хелпер. | S | низкий |
| D-18 | M | dup | `ApprovalDock.tsx:42-72`, `TaskListPage.tsx:72,88-93,131-139,212-217`, `AdminChat.tsx:200-260` | Три независимых подписки/первичных fetch'а на pending approvals (ещё и questions). Следствие: на главной странице одни и те же approval-карточки рисуются дважды (в странице и в fixed-доке; проверить визуально) — двойной клик/гонка по resolve. | Один стор (`useSyncExternalStore` на модульном состоянии, как `socket.ts`): `useApprovals()`, `usePendingQuestions()`. Убрать блок approvals из `TaskListPage` или из дока. | M | средний |
| D-19 | M | dup | `components/settings/{Access,CloudflareAccess,WebServer,Update,Sessions,Security}Settings.tsx`, `DiskSettings`, `TitleSettings`, `VisionSettings` | Идентичный скелет: `info/msg{ok,text}/busy`, `load` через `useCallback`+`useEffect`, `save` с `catch(()=>null)` и `Could not save.`; inline-style чекбокс-label повторён. 52 inline `style={{}}` по проекту. | Хук `useSettingsResource(path)` + `<CheckboxField/>` в ui; убрать inline-стили. | M | низкий |
| D-20 | M | dup | `TaskDetailPage.tsx:82-189` / `AdminChat.tsx:96-155` | Две копии логики «transcript fetch + подписка на room + dedupe по `sessionId:seq` + реконнект» (в т.ч. оба с багами D-03/D-04). | Хук `useTaskStream(taskId)` -> `{lines,status}`; чинится один раз. | M | средний |
| D-21 | L | dup | `ApprovalCard.tsx:315` (`mb()`), `VoiceSettings.tsx:94`, `lib/format-bytes.ts` | `formatBytes` есть, но дублируется вручную; даты форматируются в 4 стилях (`TaskList.tsx:69` только время, `SchedulesManager.tsx:55`, `WorkspacePage.tsx:9`, `Transcript.tsx:25`). | `lib/format.ts`: `formatBytes`, `formatDateTime`, `formatRelative`; в `TaskList` показывать дату для задач не за сегодня. | S | низкий |
| D-22 | L | dup | `TaskListPage.tsx:15-34,153-180`, `StatusBadge.tsx:4`, `Transcript.tsx:66` | Три справочника статусов с разными подписями (`review`: «Ready» vs «ready — confirm»); `pick`/`pickStatus` — копипаста по 14 строк, читают URL через `window.location` вместо `useSearchParams` (в `WorkspacePage` уже `useSearchParams`). | `lib/task-status.ts` (label, hint, tone) + `useUrlFilter(key)`. | S | низкий |
| D-23 | L | dup | `lib/voice.ts:74-103` vs `lib/transcript-look.ts:21-44` | Два самописных `usePref` на localStorage+CustomEvent. | Один `useLocalPref` на `useSyncExternalStore` (заодно кросс-табовый `storage`). | S | низкий |
| D-24 | L | dup | `FollowUpForm.module.css` / `AdminChat.module.css` (`voiceBar`, `voiceCheck`), `CreateTaskForm`/`FollowUpForm` (`attachSelect`) | Копии CSS-блоков и мёртвые классы (D-34). | Общий `VoiceToggles`-стиль. | S | низкий |
| D-25 | L | dup | `ApprovalCard.tsx` (637 строк, ~12 `*Preview` в одном файле) | Монолит; каждый Preview повторяет шаблон «эффект fetch + live-guard + `proposalHead/Body`». | Разнести по `approval/previews/*.tsx`, общий `<Proposal head body/>`, сделать `React.lazy` (план в разделе 3). | M | низкий |

### Производительность

| ID | Sev | Вид | Где | Что | Исправление | Effort | Risk |
|---|---|---|---|---|---|---|---|
| D-26 | H | perf | `main.tsx:5-13`, `vite.config.ts` | Нет ни одного lazy-роута: основной чанк 634 kB (gzip 200.5 kB), сборка предупреждает про >500 kB. Измерено. | Lazy-роуты: **434 kB (gzip 137.5)**, см. раздел 3. | S | низкий |
| D-27 **(проверка Fable: частично — чанки уже динамические, проблема только в моменте загрузки)** | H | perf | `AdminChat.tsx` -> `MascotView.tsx:19-23` | Мини-ассистент в каждой странице при загрузке тянет `lottie_light` (169 kB, gzip 48) + `aigentron_admin_states.json` как JS-модуль (261 kB, gzip 27) — это 430 kB/75 kB gzip, больше самого приложения, на каждой странице, даже когда чат закрыт. Измерено. | Грузить после `requestIdleCallback`/первого hover/открытия чата; JSON отдавать как asset (`?url` + `fetch`), чтобы не парсить 261 kB как JS. Округление чисел в JSON не помогает (проверено: -1 kB). | S | низкий |
| D-28 | H | perf | `@lds/shared` (CJS dist, `vite.config.ts:13`) | Из `@lds/shared` в рантайме нужны 3 мелочи (`SERVER_EVENT/CLIENT_EVENT`, `describeSchedule`, `USER_ROLES`, `isTerminalStatus`), а CJS не tree-shake'ится: в бандле целиком 25 kB (в т.ч. danger-классификатор, `classify`). Измерено по sourcemap. | ESM-сборка пакета (`"module"`/`exports.import`, `sideEffects:false`) или подпуть `@lds/shared/events`. Ожидаемо -20 kB min (~-6 kB gzip; оценка). | M | средний (cjs interop в vite.config) |
| D-29 | H | perf | `Transcript.tsx` целиком | Нет `memo`: каждая новая строка лога пересоздаёт все элементы; `Markdown` (`Markdown.tsx:51`) парсит текст каждый рендер; `setNow` каждые 5 с при `running` (стр. 145-149) перерисовывает весь transcript; `buildItems`, три `[...lines].reverse().find` (Transcript:177,269; TaskDetailPage:236) на каждый рендер; `setLines(prev=>[...prev,l])` — O(n²) по длине лога; на каждую строку ререндерится вся `TaskDetailPage`. Длинные сессии (тысячи строк) — не мерил, оценка. | `React.memo(Row)` с ключом по `line.id`+стабильными колбэками, `useMemo` для `buildItems`/`lastReply`, `memo(Markdown)`/`useMemo(parseMarkdown)`, таймер «тишины» вынести в маленький дочерний компонент; для >500 строк — виртуализация (`@tanstack/react-virtual` ~4 kB) или `content-visibility:auto` на `.line` (дёшево, S). | M | средний |
| D-30 | M | perf | `Transcript.tsx:213-262` | Миниатюры вложений — это оригиналы (`attachmentUrl`), `<img>` в `thumbs` без `loading="lazy"`/`decoding="async"` (в `album` lazy есть); те же оригиналы в `Attachments.tsx:94`, `FollowUpForm.tsx:246`. Скриншоты агента могут быть мегабайтными. | `loading=lazy decoding=async`, серверный `?w=320` ресайз (отдельная задача для orchestrator). | S/M | низкий |
| D-31 | M | perf | `DiscussionBar.tsx:19` (2.5 с), `KnowledgePage.tsx:73` (4 с), `ChannelsManager.tsx:47` (5 с, 1+N запросов), `McpEndpointManager.tsx:48` (5 с), `DiskBanner.tsx:27` (60 с, глобально), `ApprovalDock.tsx:105` (1 с, пока есть approvals) | Поллинг не останавливается в скрытой вкладке. `ChannelsManager` делает N+1 запросов каждые 5 с. | Хук `usePolling(fn, ms)` с `document.visibilityState` + паузой; для discussion — слушать сокет вместо поллинга; `listPairings` одним эндпоинтом. | S | низкий |
| D-32 | M | perf | `AdminChat.tsx:208-216` | На каждое `taskStatus` любой задачи меняется `activeTasks` -> перерисовывается весь AdminChat (с историей сообщений). Каждая страница при монтировании делает `listTasks({pageSize:100})` ради маскота. | Вынести маскот-индикатор в отдельный компонент со своей подпиской; серверный эндпоинт счётчиков (`status-counts` уже есть) вместо 100 задач. | S | низкий |
| D-33 | L | perf | `react-router` 90 kB min в бандле (измерено) | Используется data-router (`createBrowserRouter`) ради 9 статичных роутов. | Не проверено, что `<BrowserRouter>` даст экономию в v7 — гипотеза; низкий приоритет. | M | средний |

### UX / a11y / мобильные

| ID | Sev | Вид | Где | Что | Исправление | Effort | Risk |
|---|---|---|---|---|---|---|---|
| D-35 | M | a11y | `components/ui/Modal.tsx` | Нет фокус-ловушки, нет автофокуса и возврата фокуса, нет `aria-labelledby` (заголовок есть, связи нет), нет блокировки скролла фона. Затрагивает 8 диалогов. | Доработать `Modal` в одном месте (или нативный `<dialog>`). | M | низкий |
| D-36 | M | a11y | `ui/Text.tsx:9` (`ErrorText`), ~71 места с ошибками; `Transcript.tsx:313` | `ErrorText` без `role="alert"` — ошибки не озвучиваются; у `role="log"` лишний `aria-live="polite"` (log уже live; при переключении фильтров «all/messages» перечитывается). Только 4 `role=status/aria-live` на весь проект. | `role="alert"` в `ErrorText`; `aria-relevant="additions"` у лога. | S | низкий |
| D-37 | M | a11y | `globals.css:187-193` | У `input/textarea/select` `outline:none` и фокус — только `0 0 0 2px var(--accent-soft)` (альфа 0.16): почти не виден, особенно в светлой теме. Контраст `--text-dim` светлой темы (#7d7364 на #ece5d8) на глаз ~3.5:1 < 4.5 — не мерил формально. | Видимое кольцо `outline:2px solid var(--accent)` в `:focus-visible`; перемерить `--text-dim`. | S | низкий |
| D-38 | M | ux | `CopyButton.module.css:8` (26x22), `ui/Modal.module.css:39` (26x26), `ui/Button.module.css .sm` (~26 px высота), `FollowUpForm.module.css:52-59` (28), `VoiceButtons.module.css:20` (28); `TaskList.tsx` кнопка удаления «✕» | Тач-цели < 44 px (рекомендация WCAG 2.5.5 / iOS 44, Material 48); кнопка «✕» удаления задачи рядом со ссылкой без `aria-label` и без подтверждения только `confirm()`. | Мин. 40-44 px под `@media (pointer:coarse)`; `aria-label`. | S | низкий |
| D-39 | M | ux | `ThemeToggle.module.css`, `ScrollTopButton.module.css`, `AdminChat.module.css`, `ApprovalDock.module.css` | Четыре `position:fixed` виджета у нижнего края; на 390 px ThemeToggle (left:16/bottom:16, 44 px) и ScrollTop (bottom:70) перекрывают контент (в `.app` на телефоне нижний padding 120 px — маскировка). `html,body{overflow-x:hidden}` на `<=640px` (globals.css:~213) скрывает, а не лечит горизонтальный оверфлоу. Не проверял в браузере. | Убрать оверфлоу в корне (найти виновника через devtools), перенести ThemeToggle в хедер/настройки на мобиле. | M | низкий |
| D-40 | L | ux | `AdminChat.module.css:52` | `100vh` вместо `dvh` — на мобильных браузерах панель чата уезжает под адресную строку. | `100dvh` (с fallback). | S | низкий |
| D-41 | L | ux | `TaskRelations.module.css:38,46` | `var(--muted, #888)` — переменной `--muted` нет (проверено grep) -> всегда серый #888, не следует теме. Ещё жёсткие цвета: `VoiceButtons.module.css:40-41` (`#ef4444 !important`), `AdminChat.module.css:43` (`#f59e0b`), `MediaViewer` (`#000` — уместно). Transcript имеет свои `--t-*` палитры (осознанно, обе темы покрыты). | `var(--text-dim)`, токены `--danger`/`--warn`. | S | низкий |
| D-42 | L | ux | `pages/SettingsPage.tsx:36` | Активная вкладка настроек — локальный `useState`: нет deep-link, перезагрузка/назад сбрасывает на General; вкладка General монтирует 8 карточек, каждая со своим fetch. | `useSearchParams('tab')`; lazy-подвкладки. | S | низкий |
| D-43 | L | a11y | `ui/Tabs.tsx:35-44` | `role=tab` без `tabindex` roving/стрелок, без `aria-controls`/`tabpanel`. | Стрелки Left/Right, `tabIndex`. | S | низкий |
| D-44 | L | ux | `TaskList.tsx:69` | Показывается только время создания (`toLocaleTimeString`) без даты — задачи прошлых дней неотличимы. | Дата для старше суток (D-21). | S | низкий |

### Чистка и тесты

| ID | Sev | Вид | Где | Что | Исправление | Effort | Risk |
|---|---|---|---|---|---|---|---|
| D-46 | M | cleanup | `/eslint.config.mjs` | Нет `eslint-plugin-react-hooks` — `exhaustive-deps` не ловится; уже видны подозрительные места: `usePref` (`transcript-look.ts:30-37`, deps `[key]`, но `allowed/fallback` внутри), `TaskActionPreview` (`ids`). | Подключить плагин (warn), починить находки. | S | низкий |
| D-47 | L | cleanup | `lib/*` | Мёртвые экспорты (grep): `copyText` (только внутри), `useMedia`, `voiceChanged`, `RecordResult`, `EDGE_TAB_HEIGHT`, `STATES`, часть типов `api.ts` экспортируются без внешних потребителей. Неиспользуемых методов `api.*` не найдено (все 299 где-то вызываются — по word-match, нестрого). | Снять `export` с внутренних. | S | нулевой |
| D-34 | L | cleanup | CSS-модули | Мёртвые классы (нет `styles.X` ни в одном tsx, проверено grep): `AdminChat.voiceLink,voiceCheck`; `FollowUpForm.attachSelect,draining,attachIcon,linkBtn,voiceCheck`; `CreateTaskForm.attachSelect`; `AgentsPage.warn`; `TaskDetailPage.prompt`; `UsersManager.head,meta` (проверить `entry/ident` — используются). `Badge/Button/Transcript` классы по динамическим ключам (`styles[l.kind]`) — не мёртвые. | Удалить после визуальной проверки. | S | низкий |
| D-45 | M | test | `/vitest.config.ts` (`environment:'node'`, include `apps/*/src/**/*.test.ts`) | Тестов в дашборде три (`float-position`, `markdown-parse`, `schedule-form`, 96 строк). Не покрыты чистые функции: `buildItems`, `speakerColor`, `formatBytes`, `unwrap`/сборка query в `listTasks`, `capture.isVideo`, `collapsed`, `transcript-look.read`, `isTerminalStatus`-зависимая логика, URL-фильтры `TaskListPage` (`initialStatus/Type`), dedupe строк transcript. Компоненты/хуки тестировать нечем (нет jsdom/RTL). | Тесты на чистое сразу (S); для D-03/D-04 вынести `mergeLines()` в lib и покрыть; позже jsdom + RTL для `useTaskStream`. | M | нулевой |

## 2. Топ-10 по value/effort

1. D-01+D-02 — `key={id}` на странице задачи: чужие вложения/состояние при навигации parent/subtask (S, самый дешёвый реальный баг).
2. D-26 — lazy-роуты: -200 kB в основном чанке (S).
3. D-27 — грузить маскот лениво/по idle, JSON как asset: убирает 75 kB gzip с каждой страницы (S).
4. D-03 + D-04 — мерж transcript с сокетом и догрузка после реконнекта (M; потери живых строк — самый заметный пользователю баг).
5. D-06 — коалесцирование/abort в `TaskListPage` (S; снижает трафик 3 запроса/событие).
6. D-29 (часть S) — `useMemo(buildItems)`, `memo(Markdown)`, таймер тишины в отдельный компонент, `content-visibility:auto` (S-M).
7. D-18 — единый стор approvals: убирает 3 подписки и двойные карточки (M).
8. D-36 + D-37 — `role=alert` у ошибок и видимый фокус (S, a11y в одну правку).
9. D-31 — `usePolling` с паузой в скрытой вкладке (S).
10. D-15 — единый `request()` и затем разнесение `api.ts` (L, но вынесено в план — основной долг поддерживаемости; D-10 решается заодно).

## 3. План code-splitting (с измерениями)

Базовая линия (`pnpm --filter @lds/dashboard build`, vite 6.4.3):

| Чанк | min | gzip |
|---|---|---|
| index (всё приложение + react-dom + router + socket.io) | 633.9 kB | 200.5 kB |
| aigentron_admin_states.json (уже динамический) | 261.4 kB | 27.0 kB |
| lottie_light (уже динамический) | 169.3 kB | 48.4 kB |
| css | 69.8 kB | 14.2 kB |

Состав основного чанка (по sourcemap, min-символы): react-dom 177, react-router 90, код `components` 182, `pages` 56, `lib` 31, `@lds/shared` 25, engine.io+socket.io ~40, react 8.

**Шаг 1 — lazy-роуты (измерено в копии проекта в scratchpad, исходники не менялись).** Все 8 страниц через `lazy: () => import('./pages/X')` в `createBrowserRouter`:

| Чанк | min | gzip |
|---|---|---|
| index | **434.5 kB** (было 633.9, -31%) | **137.6 kB** (было 200.5, -63 kB) |
| SettingsPage | 89.3 | 28.5 |
| TaskDetailPage | 38.4 | 13.6 |
| TaskListPage | 13.8 | 5.4 |
| KnowledgePage | 13.2 | 4.9 |
| AgentsPage | 11.3 | 4.1 |
| ResourcesPage | 7.1 | 3.0 |
| StatsPage | 6.5 | 2.7 |
| WorkspacePage | 6.1 | 2.7 |

Предупреждение >500 kB уходит. CSS тоже делится (index.css 24 kB вместо 70). Для `/secret/:token` (без авторизации) страница лёгкая: основной чанк всё равно тянет AuthGate-обвязку — не критично. Нужен `<Suspense>`/`HydrateFallback` с фоном (иначе мигание пустого экрана; не проверено).

**Шаг 2 — маскот (D-27).** Сейчас 430 kB (75 kB gzip) на каждой странице после первого рендера. Грузить по `requestIdleCallback` или при первом hover/открытии; JSON подключать как URL-ассет и `fetch`. Эффект на старте: -75 kB gzip сетевого трафика и -261 kB JS-парсинга (оценка; основной чанк не меняется).

**Шаг 3 — не в первой загрузке.** `ApprovalCard` 15.5 kB min (~5 kB gzip), нужен только когда есть pending approval: `lazy` внутри `ApprovalDock`/страниц. Затем `MediaViewer`/`CameraCapture`/`VoiceMode` (4+4+4 kB) по требованию. Ожидаемо -25 kB min в индексе (оценка по атрибуции, не собирал).

**Шаг 4 — Settings по вкладкам (89 kB).** `lazy` для каждой подвкладки (Providers, Channels, Schedules, Voice и т.д.), в сумме не меняет объём, но General открывается без остальных (оценка -50% первого захода на /settings; не мерил).

**Шаг 5 — `@lds/shared` (D-28).** -20 kB min в индексе (оценка).

**Шаг 6 — vendor-чанк.** `manualChunks: { react: ['react','react-dom'], router: ['react-router-dom'], socket: ['socket.io-client'] }` (react-dom 177 kB почти не меняется между релизами -> кешируется браузером между деплоями). Не уменьшает размер, но снижает объём перекачки при каждом релизе (в проекте релизы частые: 0.1.57, 0.1.58 в один день).

Итог после шагов 1-3 и 5 (оценка): стартовая загрузка основной страницы ~ 380 kB min / ~120 kB gzip + страница 14 kB, против 634 / 200 сейчас.

## 4. План разделения `lib/api.ts` (934 строки)

Сейчас: ~40 интерфейсов + один объект `api` из 299 свойств. Предложение (без изменения вызовов: `api` остаётся реэкспортом-фасадом):
- `lib/api/http.ts` — `request<T>()`, `ApiError`, `unwrap`, заголовки, query-builder (D-10, D-15, D-17).
- `lib/api/types/*.ts` — типы по доменам (tasks, providers, agents, channels, kb, schedules, settings).
- `lib/api/{tasks,agents,providers,channels,schedules,kb,resources,workspace,settings,approvals,maintenance,voice,auth}.ts` — по 30-120 строк; `lib/api/index.ts` собирает `export const api = {...tasks,...}`.
- `voice.ts:47-70` и `auth.ts` переносятся в те же модули (сейчас у них собственный fetch).
Эффект на бандл — нулевой (всё нужно сразу, пока AdminChat/Dock общие), цель — читаемость и тестируемость `request()` (Vitest, node-окружение подходит: нужен только `fetch`-стаб).

## 5. Что не проверялось
Реальные замеры re-render/FPS на длинных транскриптах (D-29 оценочно), поведение на 390 px в браузере (D-39, D-40), контраст светлой темы (D-37) цифрами, серверное использование `x-lds-user` (D-10), двойное отображение approvals на главной (D-18), эффект `<BrowserRouter>` на размер (D-33).
