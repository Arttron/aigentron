# Ревью 03 — файлы, ресурсы, знания, медиа (orchestrator + dashboard)

Дата: 2026-10-15. Версия: 0.1.58 (HEAD 5ed530d). Только чтение кода, ничего не менялось и не коммитилось.
Объём: `apps/orchestrator/src/{media,attachments,workspace,resources,knowledge,maintenance,prisma,config,research}` и страницы/компоненты dashboard (Resources, Knowledge, Workspace, Attachments, MediaViewer, CameraCapture, capture.ts).

Метки проверки: **[проверено]** — воспроизведено мелким скриптом (node/ffprobe), но не через запущенный HTTP-сервер; **[чтение]** — выведено из кода; **[не проверено]** — правдоподобно, не воспроизводилось.

---

## (a) Пять (на деле семь) хранилищ: пересечения и целевая модель

### Что есть сейчас

| Хранилище | Область | Кто пишет | Где лежит | Как агент это видит | Жизнь |
|---|---|---|---|---|---|
| Вложения задачи (`attachments`) + `.links.json` | одна задача | человек (upload), агент (`cp` по SOUL.md, `show_images`→adopt, скриншоты→writeImage, `workspace_save`→link) | `attachments/<taskId>/` | пути в промпте, Read, `look_at`, `read_document` | удаляются с задачей; 10 МБ / видео 300 МБ |
| Ресурсы (`resources`) | глобально, `agents[]` — только подсказка | человек (UI), агент (предложение заметки с апрувом) | `agent/resources/files` + `index.json` | блок «Project resources» (≤25) + `resources_search` + Read | вечно; 25 МБ / видео 300 МБ / 2 ГБ / 500 шт |
| Workspace (`memory/work/deliverables`) | глобально (один на установку) | агенты (`workspace_*`), человек (work/, бриф) | `workspace/` | дайджест памяти в промпте, `workspace_files/save/note`, Read | вечно; save 50 МБ, `.versions` без лимита |
| Knowledge bases | глобально, ACL по агентам (в коде) | человек, агент (`kb_add`, если разрешено) | **только БД** (чанки + векторы); исходный файл не хранится | `kb_list/search/read/add` | вечно; 20 МБ файл / 5 М симв. / 20k чанков |
| Research cache | глобально | инструмент `fetch` | `agent/research-cache/*.json` | `fetch`, `verify_quote` | 180 дней |
| Run-папки | задача | рантайм агента | `agent/runs/<taskId>` | рабочий каталог | 14 дней |
| Кэши дайджестов видео | рядом с файлом | `video_digest` | `<файл>.digest/` (в attachments, resources, **и где угодно**, куда ссылается путь) | кадры → `look_at` | 30 дней, но чистится не везде (F-16) |

Инструменты агента, которые покрывают эту территорию: `resources_search`, `kb_list/search/read/add`, `workspace_info/files/note/save`, `read_document`, `show_images`, `look_at`, `video_digest`, `research.fetch/search/verify_quote`, предложение заметки в ресурсы. Это ~15 инструментов поверх 7 мест; выбор «куда положить/где искать» агент и человек делают сами.

### Где реально пересекаются

1. **Resources ↔ Workspace.** Обе — «общие файлы проекта, которыми управляют люди и агенты», две страницы, два пути браузинга/выдачи/загрузки, две модели адресации (по `id` и по относительному пути). `docs/plan-projects-workspace.md` уже предлагает `library/` внутри папки проекта — то есть сами планы считают Resources частью Workspace.
2. **Resources ↔ Knowledge.** Комментарий в `resources.service.ts` называет ресурсы «file-based stand-in for a knowledge base». Одни и те же типы (md/txt/csv/pdf/docx), два разных поиска (подстрока по title/description против BM25+эмбеддинги), и «импорт ресурса в KB» — это копия текста без синхронизации (`importResource`, knowledge.service.ts:334). Человеку на странице Knowledge приходится читать подсказку, чтобы выбрать, куда класть.
3. **Attachments ↔ Workspace.** Уже де-факто слой «вид»: `link()` показывает файл из workspace/ресурсов в галерее задачи без копии. Но SOUL.md (стр. 152-170) одновременно учит двум способам отдать результат: `cp` в `$LDS_ATTACHMENTS_DIR` (требует апрува, лимит 10 МБ, без версий) и `workspace_save` (50 МБ, версии, ссылка) — «не делай оба». Это противоречие в промпте стоит токенов и порождает ошибки.
4. **«Где лежит факт»:** `memory/facts.md` (агент, всегда в промпте, ≤6 КБ), заметка в Resources (человек, индекс в промпте), `kb_add` (агент, search-only). Правило выбора нигде не сформулировано.
5. **Research cache ↔ KB.** Кэш — по сути хранилище «веб-документов», KB-импорт копирует его (`importResearch`), дубли отсекаются только по хэшу текста: обновившаяся страница попадает в KB второй раз (F-25). Research при этом отказывается от PDF (research.service.ts:243), хотя `knowledge/extract.ts` уже умеет PDF/DOCX.
6. **Вторичные «хвосты»:** `.digest` рядом с файлами, `adopted-images.json` в run-папке, `.versions`, `.links.json`, `.log.md` — служебные данные раскиданы по пользовательским папкам и чистятся по-разному.

### Рекомендуемая модель (3 слоя + кэш)

Принцип: **разделять по способу доступа, а не по «виду» данных.**

- **Слой 1 — Файлы (один код, зоны).** Один `FileStore` (safe-path, потоковая запись tmp+rename, выдача, таблица типов, лимиты/квоты). Зоны:
  - `inbox` = вложения задач (остаётся `attachments/<taskId>/`, семантика «жизнь = жизнь задачи» сохраняется) — вход человек→агент и «витрина» ссылок на чужие файлы;
  - `library/` = **Resources переезжают сюда** (метаданные `index.json` сохраняются: title/description/tags — они нужны агенту для выбора);
  - `work/`, `deliverables/` (версии с ротацией), `memory/` — как сейчас.
  Дашборд: одна страница Files с вкладками Library / Work / Deliverables / Memory; `/resources` остаётся как отфильтрованный вид library на переходный период.
- **Слой 2 — Знания (индекс, а не склад).** KB — поисковый индекс над файлами и веб-страницами: у документа есть `sourceRef` (путь в library / id ресурса / URL) и `contentHash`; при изменении источника переиндексация (upsert по `(kbId, source)`), а не новая копия. Загрузка «в KB» = «положить в library + проиндексировать в базу X» (галочка). Исходник больше не теряется. Опционально позже: виртуальная база `library` (все файлы библиотеки), чтобы `resources_search` слился в `kb_search`.
- **Слой 3 — Память проекта** (`memory/`, бриф) — короткое, всегда в промпте; остаётся отдельным (другой паттерн доступа: «всегда в контексте»).
- **Кэш (регенерируемое).** Единый корень `<data>/cache/{research,digests,images}`, один политик очистки, один отчёт. Research-кэш остаётся как неизменяемое хранилище доказательств (по URL+хэш) — это его ценность для `verify_quote`, — но использует общий `extractDocument` (PDF) и импортируется в KB по ссылке.

**Правило для людей и агентов (одна фраза в промпт вместо трёх абзацев):**
«Всегда в контексте и коротко → memory/brief. Лежит файлом и читается целиком → library (описание обязательно). Большое и ищется по смыслу → KB. Результат для человека → `workspace_save` (появляется во вложениях задачи сам).»

### Что объединить / оставить / убрать, стоимость миграции

| Решение | Что | Стоимость | Риск |
|---|---|---|---|
| **Оставить** | attachments как per-task inbox + links; KB в БД; research-кэш; workspace `memory/` и версии deliverables | — | — |
| **Объединить** | Resources → `workspace/library` (физический перенос + симлинк `agent/resources` на один релиз; пути в `media.service.ts:34`, `attachments.service.ts:181`, `maintenance.service.ts:99,330`, `packs` (`addFromPath`), промпт-индекс, KB-импорт). URL ресурсов по `id` не меняются → дашборд почти не трогается | M (≈2-3 дня + миграционный тест) | средний: возобновляемые сессии агентов помнят старые абсолютные пути → симлинк обязателен |
| **Объединить (код)** | один `file-types` (mime/ext/kind/limits), один `fs-safe`, один `file-io` (сохранение потока + выдача) вместо 4+5+3 копий (F-44…F-49) | M | низкий, хорошо покрывается тестами |
| **Изменить** | KB-документ получает `sourceRef/contentHash`, upsert вместо копии; `importResearch` по URL | M (миграция БД: 2 nullable-колонки, Postgres+SQLite) | низкий |
| **Убрать/заменить** | `cp` в `$LDS_ATTACHMENTS_DIR` как официальный способ отдачи (оставить каталог для скриншотов/`show_images`); дать один инструмент «показать файл в задаче» поверх `link()`; правка SOUL.md | S (текст) + S (инструмент) | низкий; поведение агентов проверить прогоном |
| **Убрать** | `.digest` рядом с файлами → `cache/digests/<hash>` (устраняет F-15/F-16) | S-M | низкий (кэш регенерируем) |
| **Не объединять** | attachments физически в workspace: другой жизненный цикл (удаляются с задачей), другая семантика доступа | — | — |
| **Отложить** | слияние `resources_search` в `kb_search` (виртуальная база library) | L | средний — сначала мерить, нужен ли второй поиск |

Согласуется с `docs/plan-projects-workspace.md` (`library/` в папке проекта): этот план — шаг к нему, делать его до «проектов» стоит как «Шаг 0».

---

## (b) Находки

Серьёзность: critical / high / medium / low. Вид: bug / sec / dup / perf / cleanup / test / design. Усилие: S ≤ полдня, M ≤ 2-3 дня, L больше.

### Безопасность и падения

| ID | Sev | Вид | Где | Что | Исправление | Усилие | Риск |
|---|---|---|---|---|---|---|---|
| F-01 **(исправлено в `main` c39279d, 2026-10-15)** | **critical** | bug/sec | `attachments/attachments.controller.ts:28-39`, `resources/resources.controller.ts:57`, `media/serve-range.ts:14,25` | `createReadStream(path).pipe(res)` без обработчика `error`. `sanitize('..') === '..'` и `'.'`, `'x.mp4.digest'` проходят (`attachments.service.ts:276-288`: `access()` на каталоге успешен) → чтение каталога даёт `EISDIR` → необработанное событие → `main.ts:21` делает `process.exit(1)`. **[проверено]** на уровне node: `sanitize('..')`, и стрим каталога → uncaughtException; HTTP-маршрут не запускался. Любой пользователь, даже `reviewer`, может уронить оркестратор (`GET /api/tasks/<id>/attachments/%2e%2e`). Похоже и для ресурса, чей файл удалён вручную (ENOENT) | Один `serveFile()` в общем `file-io`: `stat` + `isFile()`, `pipeline(stream, res, cb)` с обработкой ошибок и `destroy` при `res.close`; `filePath()` отвергает не-файлы и имена на «.» | S | низкий |
| F-02 **(исправлено в `main` c39279d)** | high | bug | `attachments/attachments.controller.ts:35` | `content-disposition: attachment; filename="${name}"`: `sanitize` намеренно сохраняет кириллицу/CJK, а Node бросает `ERR_INVALID_CHAR` на символах >0xFF → **500 при скачивании любого не-inline вложения с русским именем** (.docx/.xlsx/.zip/.csv). **[проверено]** в node. Для русскоязычного владельца — частый сценарий | `filename*=UTF-8''<encodeURIComponent>` + ASCII-fallback, как уже сделано в `workspace.controller.ts:30` (вынести в хелпер) | S | низкий |
| F-03 | low | bug | `resources/resources.controller.ts:55` | `filename="${encodeURIComponent(originalName)}"` — скачанный файл называется `%D0%BA%D1%83…` | тот же хелпер | S | низкий |
| F-04 | medium | sec | `attachments/attachments.controller.ts:16-20` | `POST /tasks/:id/attachments` без `RolesGuard`, без проверки существования задачи, без квоты: любая роль × любой `taskId` (`^[\w-]+$`) × до 300 МБ → заполнение диска; каталоги несуществующих задач никто не удаляет (`maintenance` только отчитывается, :300). Плюс `decodeURIComponent` без try (:18, и `resources.controller.ts:37`) → `URIError` → 500 | `@Roles('operator','admin','task_setter')`, проверка задачи в БД, квота на задачу (напр. 1 ГБ), безопасный decode | S | низкий (проверить, кто из ролей реально грузит: reviewer?) |
| F-05 | medium | sec | `attachments/attachments.controller.ts:30-35` | Нет `x-content-type-options: nosniff` (в resources и workspace есть). Inline-тип выбирается только по расширению, содержимое не проверяется; PDF отдаётся inline с того же origin | на всех выдачах `nosniff` + `content-security-policy: sandbox; default-src 'none'`; при загрузке сверять magic bytes для inline-типов (png/jpg/webp/gif/pdf), иначе принудительное скачивание | S | низкий |
| F-06 | medium | sec | `media/image-optimizer.service.ts:32,68`, `media/video.service.ts:42,~120` | ffprobe/ffmpeg запускаются на недоверенных файлах; формат определяется по содержимому, а не по расширению: известный класс атак «файл .png/.mp4 с HLS/concat-плейлистом читает локальные файлы», результат уходит в кадры → vision-модель. **[не проверено]** (не воспроизводилось) | `-protocol_whitelist file,pipe`, явный `-f` (image2 / mov,mp4,matroska,webm) или проверка magic bytes до запуска, `-nostdin`; запускать с `ulimit`/таймаутом (есть) | S | низкий |
| F-07 | medium | sec | `media/media.service.ts:34-35`, `config/app-config.service.ts:194`, `media/media-core.ts:175-180` | `process.env.WORKSPACE_DIR ?? …`: пустая строка (`WORKSPACE_DIR=` в .env) не заменяется → root `''`; `insideRoot` нормализует его в `''`, и `p.startsWith('/')` истинно для любого абсолютного пути; на втором шаге `realpath('')` падает и подставляется `''` → **любой файл доступен `look_at`/`video_digest`/`read_document`/`show_images`**. `maintenance.service.ts:331` сам допускает пустое значение. **[чтение]** | в config `\|\|` вместо `??`; `roots.filter(Boolean)`; `insideRoot` игнорирует пустой root | S | низкий |
| F-08 | medium | sec/perf | `research/research.service.ts:179-181` | `gunzipSync/inflateSync/brotliDecompressSync` без `maxOutputLength`: 3 МБ сжатого → гигабайты в памяти → OOM всего оркестратора; плюс синхронно в event loop. Риск ограничен allow-листом доменов (но редиректы/компрометированный официальный сайт) | `{ maxOutputLength: 12 * 1024 * 1024 }`; ловить `ERR_BUFFER_TOO_LARGE` | S | низкий |
| F-09 | low | sec | `workspace/workspace.service.ts:170`, `media/media.service.ts:34` | Допустимые корни — весь `attachmentsDir`, а не каталог текущей задачи: агент задачи A читает/копирует вложения задачи B (workspace_save `from`, read_document, look_at) | передавать `attachments.dir(taskId)` | S | низкий |
| F-10 | low | sec | `workspace/workspace.service.ts:160-163,188-189` | Проверка `realpath` только каталога назначения; если `dest` уже симлинк внутри `deliverables/` (агент пишет в workspace напрямую через `writeRoots`) — `copyFile/writeFile` пишет по ссылке наружу | `lstat(dest)`, отказ для симлинков | S | низкий |
| F-11 | low | sec | `attachments/attachments.service.ts:321-325,272-288` | `sanitize` не убирает ведущие точки: `.links.json` скачивается через `GET …/attachments/.links.json` (абсолютные пути хоста), а загрузка файла с таким именем (пока его нет) становится картой ссылок | запретить имена на «.» и зарезервированные | S | низкий |
| F-12 | low | bug | `attachments/attachments.service.ts:239-261,272-283,305-317` | `uniqueName` не знает про ссылки: загруженный `result.pdf` затеняет одноимённую ссылку (в `list` и `filePath` приоритет у своего файла) | учитывать `links` в `uniqueName` | S | низкий |
| F-13 | medium | design/sec | `resources/resources-core.ts:107`, `media.service.ts:34` | `agents[]` у ресурса — только фильтр промпт-индекса и `resources_search`; сам файл читается любым агентом (Read / `safePath` по всей `resources/`). KB обеспечивает ACL в коде (`visible()`), ресурсы — нет. Обещание «для этих агентов» в UI вводит в заблуждение | либо переименовать в «рекомендуемый охват» в UI, либо enforcement в `safePath`/prompt-hook | S (UI) / M | низкий |

### Баги и гонки

| ID | Sev | Вид | Где | Что | Исправление | Усилие | Риск |
|---|---|---|---|---|---|---|---|
| F-14 | high | bug | `media/media-core.ts:105-113`; клиент `CameraCapture.tsx:72-78` | Видео, записанное в браузере (MediaRecorder, Chrome/Android → webm), не имеет `format.duration` (**[проверено]**: живой webm через ffprobe не отдаёт `duration`) → `parseProbe` возвращает `null` → «That does not look like a video I can read». На Safari (mp4) работает. То есть «снять клип камерой в дашборде» ломает `video_digest`/`look_at` на части устройств | fallback длительности: `ffprobe -count_packets`/последний `pts_time`, либо ремукс `ffmpeg -c copy` в mp4 при загрузке; тест на webm без duration | S-M | низкий |
| F-15 | medium | bug | `media/video.service.ts:56-62,~125-130`; `maintenance.service.ts:139-153,167` | Ключ `running` включает план кадров, а `build` стирает все файлы папки, кроме `transcript.json`: два параллельных вызова на один файл с разными планами портят друг другу кадры (`cache incomplete`/ENOENT). `pruneCaches`/`relieve` (digestDays=0) удаляют и дайджесты, которые в работе | сериализовать по файлу (ключ = путь) или подпапка на план; prune пропускает свежие (mtime < 10 мин) | S-M | низкий |
| F-16 | medium | bug/disk | `media/video.service.ts:105`, `maintenance/maintenance.service.ts:98-111` | `<файл>.digest` создаётся рядом с любым файлом, который прошёл `safePath` (workspace, worktree проекта, ресурсы), а `digestDirs()` сканирует только `resources/files` и `attachments/<task>`: дайджесты в workspace и в git-worktree **никогда не чистятся**, видны в Workspace UI (скрываются только имена на «.») и мусорят репозиторий проекта | складывать в `cache/digests/<sha(path+mtime+size)>` | M | низкий |
| F-17 | medium | disk | `workspace/workspace.service.ts:184-187,346` | `deliverables/.versions` — полная копия при каждой перезаписи, без ротации, скрыта от `walk/summary/size` и от UI (нет ни просмотра, ни восстановления, ни очистки). До 50 МБ × число перезаписей | хранить N последних (напр. 5) + TTL; показать в summary; кнопка restore в UI | S-M | низкий |
| F-18 | medium | disk | `maintenance/maintenance.service.ts:300-313` | Вложения завершённых задач (в т.ч. видео до 300 МБ) не чистятся никогда, только отчёт «oldTasksBytes». Для камеры/видео-сценария это главный источник роста | опция retention (по умолчанию выкл.) + «сжать»: удалить `.digest`, предложить топ-N самых больших; в отчёт — топ файлов | M | низкий |
| F-19 | medium | bug | `resources/resources.service.ts:147-190` | Файл полностью пишется на диск, и только потом `room()`; при отказе (`PayloadTooLarge/BadRequest`) `catch` удаляет `dest`, но если оптимизатор уже превратил PNG→JPG (`storedFile` ≠ `file`), сиротский файл остаётся навсегда (usage считает по индексу, в диск-отчёт он попадает без пояснения) | проверять `room()` по `content-length` до записи; в `catch` удалять и `storedFile` | S | низкий |
| F-20 | low | bug | `resources/resources.service.ts:73-80` | `read()` глотает любую ошибку (EACCES, битый JSON) и возвращает `[]`; следующая запись `write()` перезапишет `index.json` — потеря всех метаданных при файлах-сиротах | `ENOENT`→`[]`, остальное — бросать; `index.json.bak` | S | низкий |
| F-21 | low | bug/dup | `resources/resources-core.ts:37,56-63` | `mkv/avi/3gp` в ресурсах = `kind:'file'` с лимитом 25 МБ и без подсказки про `video_digest`, хотя attachments/media считают их видео (300 МБ) | единая таблица типов (F-44) | S | низкий |
| F-22 | low | bug | `attachments/attachments.service.ts:146-156,163-175` | `adopt` допускает 30 МБ (`MAX_BYTES*3`), `save` 10 МБ; `writeImage` декодирует base64 до проверки размера (аллокация) и перезаписывает одноимённый файл (не `uniqueName`) — скриншот `screenshot.png` затирает загруженный пользователем | проверять длину base64 до декодирования; `uniqueName` | S | низкий |
| F-23 | low | bug | `attachments/attachments.service.ts:112-129` | Запись сразу в итоговое имя (без tmp+rename и без `wx`): частично загруженный файл виден в `list()`/галерее/`sendRunAttachments`; два параллельных аплоада с одним именем пишут в один файл. В workspace уже сделано правильно (`.part`+rename) | общий `saveStream()` (tmp в `.part`, `rename`, `wx`) | S | низкий |
| F-24 | low | bug | `attachments/attachments.service.ts:208` | `linkChain` (Map по taskId) не чистится — мелкая утечка | удалять запись, если цепочка пуста | S | низкий |
| F-25 | medium | bug/design | `knowledge/knowledge.service.ts:334-369` | Импорт ресурса/кэша — копия без синхронизации; дедуп только по хэшу нормализованного текста → изменившаяся страница/заметка добавляется вторым документом (в поиске живут и старая, и новая версии); чтение всех файлов кэша последовательно, на каждый — `findUnique+count+create+invalidate+запуск embed` | `sourceRef` + `contentHash`, upsert по `(kbId, source)` с заменой чанков; пакетный импорт с одним `invalidate` | M | низкий |
| F-26 | low | bug | `knowledge/knowledge.service.ts:299-304` | Проверка дубликата и лимита чанков не атомарна: параллельная загрузка одного текста → нарушение unique `kbId_hash` → 500 | ловить P2002 → вернуть `duplicate:true` | S | низкий |
| F-27 | low | bug | `research/research.service.ts:268-269,196-206` | Запись кэша не атомарна (`writeFile`): параллельный `fetch` того же URL / `verify_quote` во время записи читает обрезанный JSON → «NOT CHECKED». Автоочистка через 180 дней (`maintenance.service.ts:90`) тихо ломает обещание «цитату можно перепроверить» | tmp+rename; в ответе verify различать «не загружено» и «кэш очищен» | S | низкий |
| F-28 | low | bug | `media/video.service.ts:136-141` | `load()` отдаёт `durationSec: 0` → при повторном вызове `look_at` теряется «видео длиной N с» во вводной фразе | хранить duration в `frames.json` | S | низкий |

### Производительность

| ID | Sev | Вид | Где | Что | Исправление | Усилие | Риск |
|---|---|---|---|---|---|---|---|
| F-29 | medium | perf | `workspace/workspace.service.ts:340-359,321-332,198-215` | `walk()` делает `await stat` по одному файлу, до 5000 (files) / 20000 (summary ×3 папки) записей и сортирует; `GET /workspace` (summary) вызывается на каждой загрузке страницы | батчи `Promise.all` по Dirent, кэш summary 30-60 с, либо счётчики | S | низкий |
| F-30 | low | perf | `workspace/workspace.service.ts:59-63` и вызовы в 95,112,156,199,254,322 | `ensureLayout()` на каждой операции, включая чтение: 3 `mkdir` + 6 неудачных `writeFile(wx)` | один раз при init + флаг; повтор только при ENOENT | S | низкий |
| F-31 | low | perf | `media/serve-range.ts:9` | `statSync` в обработчике (блокирует; при отсутствии файла бросает синхронно → 500) | `await stat` в общем `serveFile` | S | низкий |
| F-32 | medium | perf | `knowledge/knowledge.service.ts:293-320` | `chunkText` до 5 М символов выполняется синхронно в запросе (блок event loop на секунды, как и `preview`, :385-394), затем один вложенный `create` до 20 000 строк одним оператором (на SQLite возможен лимит переменных — **[не проверено]**) | чанкинг с `setImmediate`-страницами; запись `createMany` пачками по 500 в транзакции | M | средний |
| F-33 | low | perf | `knowledge/knowledge.service.ts:271-276` | `embedMissing`: по одному `update` на чанк (32 запроса на пачку) | `$transaction` / пакетный SQL | S | низкий |
| F-34 | low | perf | `knowledge/knowledge.service.ts:118-139,502-510,565-571` | N+1: на **каждый** старт задачи `promptBlock` читает все базы и по 3 `count` на базу | `groupBy`-счётчики, кэш с инвалидацией по `invalidate()` | S | низкий |
| F-35 | low | perf | `maintenance/maintenance.service.ts:98-128,236-250,300-313,315-334` | Отчёт порождает `du` на каждую папку вложений/дайджеста/устаревшего запуска — последовательно, O(число задач) процессов; вызывается со страницы Settings | один обход на корень с агрегацией по детям, кэш 5 мин | S-M | низкий |
| F-36 | low | perf | `apps/dashboard/src/components/Attachments.tsx:74-102` | `hidden={!open}` не мешает браузеру грузить: при свёрнутой галерее подтягиваются все оригиналы `<img>`/`<video>` | рендерить плитки только при `open`, `loading="lazy"`; серверные превью — позже | S | низкий |
| F-37 | low | perf | `channels/channel-manager.service.ts:491,540` (вне scope, но замыкает цепочку) | Отправка вложения в канал читает файл целиком (`readFile`, до 300 МБ); `sentAttachments` — в памяти (после рестарта всё уходит повторно). **[чтение]** | потоковая отправка/лимит для канала; хранить отправленные в БД | S-M | низкий |

### Дубли

| ID | Sev | Вид | Где | Что | Исправление | Усилие | Риск |
|---|---|---|---|---|---|---|---|
| F-38 | medium | dup | `attachments.service.ts:19-59`, `resources-core.ts:36-64`, `workspace-core.ts:123-132`, `media-core.ts:3-4,95`, `knowledge/kb-core.ts:299`, dashboard `capture.ts:3`, `WorkspacePage.tsx:8-9`, `ResourcesPage.tsx` | Таблицы mime/расширений в 8 местах; `['jpg','jpeg','png','webp']` ×4; `VIDEO_EXTS` ×2; `TEXT_EXT` ×4 — и они уже расходятся (F-21, mkv, txt-типы) | `packages/shared/src/file-types.ts`: `{ext → mime, kind, inlineSafe, text, maxBytes}`; всё остальное — производные | M | низкий |
| F-39 | medium | dup | `media-core.ts:175` (строковая), `attachments.service.ts:199-205` (realpath+sep), `workspace.service.ts:160-170,227-250`, `mcp-host.service.ts:675`, `shared/classify.ts:395` | Пять разных реализаций «внутри корня». Только часть делает realpath; одна (`insideRoot`) уязвима к пустому корню (F-07) | один `fs-safe.ts`: `resolveInside(roots, path, {mustExist, followSymlinks:false})` с realpath предка и отказом пустым корням | M | средний — поведение путей чувствительно, нужны тесты на симлинки |
| F-40 | low | dup | `attachments.service.ts:321` (`sanitize`, сохраняет юникод и регистр), `resources-core.ts:98` (`safeFileName`, slug+lowercase+ext≤8), `workspace-core.ts:65` (`safeRelative`) | Три политики имён файлов | оставить две (имя файла / относительный путь) в `fs-safe` | S | низкий |
| F-41 | medium | dup | `attachments.service.ts:115-129`, `resources.service.ts:155-190`, `workspace.service.ts:288-307`, `knowledge.controller.ts:10-20` | Потоковая загрузка в 4 вариантах (3 различных защиты от обрыва, tmp+rename только в одном, буфер в памяти в четвёртом); выдача в 3 контроллерах с разными заголовками (nosniff, filename) и без обработки ошибок | `file-io.ts`: `saveStream({dest,limit,tmp:true})`, `serveFile({req,res,path,name,kind})` | M | низкий |
| F-42 | low | dup | `knowledge/kb-core.ts:282-297`, `research/research-text.ts:51-77` | Два `htmlToText`: версия KB теряет числовые сущности, `main/article`, `nav/footer`, заголовки без `#` (для нормативных текстов номера пунктов важны) | оставить версию из research | S | низкий |
| F-43 | low | dup | `media-core.ts:6`, `resources-core.ts:30`, `attachments.service.ts:68` (300 МБ ×3), `MAX_FILE_BYTES` с разным смыслом в resources-core.ts:28 и knowledge.service.ts:62 | Лимиты разбросаны; клиент не знает серверных лимитов (грузит весь файл и получает 413) | один `limits.ts`, отдавать клиенту через `GET /media` | S | низкий |
| F-44 | low | dup | dashboard: `kb`/`size` (форматтеры), `IMAGE/TEXT` наборы, `fail`-regex, 4 fetch-загрузки в `lib/api.ts`, `MAX_SIDE=1600` в `capture.ts:5` и `MediaViewer.tsx:7` | Дубли UI-кода | `lib/format.ts`, `lib/upload.ts` | S | низкий |
| F-45 | low | design | `agent/SOUL.md:150-170` | Два способа отдать файл (`cp` в `$LDS_ATTACHMENTS_DIR`, «не более 10 МБ» против `workspace_save`, 50 МБ) и «не делай оба» | одна инструкция: результат = `workspace_save` (появляется во вложениях); каталог вложений только для `show_images`/скриншотов | S | низкий |
| F-46 | low | design | `dashboard/src/lib/capture.ts:14-35`, `image-optimizer.service.ts:14` | Клиент сжимает всё до 1600 px JPEG q.88, сервер для библиотеки собирался дать 2000 px (`RESOURCE_MAX_SIDE`) — константа фактически мертва для дашборда; двойное сжатие с потерями для эталонных фото библиотеки | не пережимать на клиенте для library; значения брать из `/media` | S | низкий |
| F-47 | low | design | `research/research.service.ts:243` | Research отказывается от PDF, хотя `knowledge/extract.ts` умеет PDF (официальные реестры часто публикуют PDF) | использовать `extractDocument` с лимитами | M | низкий |
| F-48 | low | design | `WorkspacePage.tsx`, `workspace.controller.ts:24-33` | Видео в `work/` нельзя посмотреть (выдача без Range); загрузка в `work/` молча перезаписывает файл без версий (в отличие от deliverables) | `serveFile` с Range; при перезаписи — `.versions` как в save | S | низкий |
| F-49 | low | design | `CameraCapture.tsx:53-85` | Запись клипа целиком копится в памяти без лимита по размеру/времени (сервер: 300 МБ/20 мин) | остановка по лимиту, предупреждение | S | низкий |

### Мёртвый код (проверено grep)

| ID | Sev | Вид | Где | Что | Исправление | Усилие | Риск |
|---|---|---|---|---|---|---|---|
| F-50 | low | cleanup | `workspace/workspace.service.ts:218-222` | `size()` — нет ни одного вызова (summary считает сам) | удалить | S | нет |
| F-51 | low | cleanup | `knowledge/extract.ts:19-21` | `BINARY_DOC_EXTS`, `isReadableDoc` — нет импортов | удалить | S | нет |
| F-52 | low | cleanup | `research/research.service.ts:10`, `maintenance/disk-monitor.service.ts:115` | Реэкспорты (`htmlToText`, `isPrivateAddress`, `normalizeForQuote`, `DEFAULT_THRESHOLDS`) — импортёров нет (тесты берут из `*-text`/`*-core`) | удалить | S | нет |

### Пробелы в тестах

| ID | Sev | Вид | Где | Что | Исправление | Усилие | Риск |
|---|---|---|---|---|---|---|---|
| F-53 | medium | test | `attachments/` | Тест есть только на `link` (7 кейсов). Нет: `save` (лимиты, обрыв, оптимизация PNG→JPG, `uniqueName`), `sanitize` (юникод, `..`, `.links.json`), `filePath` (каталог/симлинк/ссылка), `writeImage`, `adopt`. F-01/F-02/F-11/F-12 прошли бы незамеченными | юнит + интеграционный тест контроллера (supertest) с `..`, кириллицей, каталогом | M | — |
| F-54 | medium | test | все контроллеры scope | Ни одного теста контроллера: заголовки выдачи (nosniff, disposition, Range 206/416), роли, `decodeURIComponent` | supertest-набор на `serveFile` и роуты загрузки | M | — |
| F-55 | medium | test | `media/media.service.ts`, `video.service.ts`, `serve-range.ts` | Нет тестов на `safePath` (пустой корень, симлинки), конкурентные дайджесты, webm без duration (`parseProbe` тестируется только на «хороших» JSON) | добавить; для ffmpeg — фикстуры из 1 с | M | — |
| F-56 | medium | test | `resources/resources.service.ts` | Только `resources-core`; нет `upload/room/update/remove`, очереди `locked`, сироты после PNG→JPG | добавить | M | — |
| F-57 | low | test | `knowledge/` | `extract.ts` (zip-бомба, PDF без текста, docx) и поток `addDocument/embedMissing/search` без тестов (service-тест — 4 кейса про видимость) | добавить с фейковым провайдером эмбеддингов | M | — |
| F-58 | low | test | `maintenance/` | `cleanup/staleRuns/relieve/worktreeState` без тестов (только кэши, 3 кейса) — а это удаление данных | тесты на tmp-каталогах, включая «живую задачу не трогать» | M | — |
| F-59 | low | test | `research/research.service.ts` | Нет тестов на редиректы/allow-лист/сжатие/кэш (есть только `research-text`) | мок `httpsRequest` | M | — |
| F-60 | low | test | dashboard: `Attachments`, `MediaViewer`, `CameraCapture`, `ResourcesPage`, `KnowledgePage`, `WorkspacePage`, `capture.ts` | В дашборде тестируются только `markdown-parse`, `float-position`, `schedule-form`; `prepareFile` (канвас/EXIF) и логика MediaViewer без покрытия | выделить чистые функции, добавить vitest | M | — |

Что **хорошо** (для баланса): `workspace` — самый зрелый модуль (realpath предка, tmp+rename, сериализация, 17 тестов); KB — аккуратная инвалидация индекса по поколениям и постраничная сборка с `setImmediate`; `extract.ts` защищён от zip-бомб и таймаутов; research — SSRF-защита на уровне `lookup` с allow-листом и проверкой редиректов; загрузки не используют multer, лимиты на потоке.

---

## (c) Топ-10 по ценности/усилию

| # | ID | Почему | Усилие |
|---|---|---|---|
| 1 | F-01 | Любой пользователь может уронить процесс одним GET; решается общим `serveFile` | S |
| 2 | F-02 | 500 при скачивании файлов с русскими именами — прямой удар по основному сценарию владельца | S |
| 3 | F-14 | Клипы с камеры дашборда на Chrome/Android не читаются `video_digest/look_at` (проверено на ffprobe) | S-M |
| 4 | F-04 + F-05 | Загрузка без роли/квоты/существования задачи + нет nosniff/CSP: закрываются вместе с F-01 в `file-io` | S |
| 5 | F-07 | Пустой `WORKSPACE_DIR` открывает чтение любых файлов агентам; правка в 3 строки | S |
| 6 | F-08 | Gzip-бомба в research — OOM всего оркестратора; одна опция | S |
| 7 | F-16 + F-15 | Переезд `.digest` в `cache/digests`: убирает гонки, мусор в git-worktree и «вечные» кэши вне прунинга | M |
| 8 | F-17 | `.versions` без ротации и невидимые — тихий рост диска | S-M |
| 9 | F-45 + F-25 | Одна инструкция в SOUL.md про отдачу файла (экономит токены и апрувы) + KB-upsert по источнику (убирает устаревшие дубли) | S + M |
| 10 | F-38/F-39/F-41 | Единые `file-types`/`fs-safe`/`file-io` — фундамент для слияния Resources→`library/` и защита от повторения F-01…F-07 | M |

Порядок работ, который я бы выбрал: (1) `file-io` + F-01/02/03/05/31 и тесты F-53/54 → (2) F-04, F-07, F-08, F-14 → (3) `file-types`/`fs-safe` → (4) переезд дайджестов и ротация версий → (5) перенос Resources в `library/` и `sourceRef` в KB.
