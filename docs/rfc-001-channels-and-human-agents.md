# RFC-001 — Внешние каналы общения и люди-как-агенты

- **Статус:** Draft (на обсуждение)
- **Автор:** —
- **Дата:** 2026-07-02
- **Область:** `apps/orchestrator`, `apps/dashboard`, `packages/shared`

---

## 1. Мотивация

Сегодня единственный клиент оркестратора — дашборд (Next.js), общающийся по REST +
Socket.IO. Все действия человека (создать задачу, ответить агенту, аппрувить опасную
операцию) идут через браузер.

Мы хотим:

1. **Управлять проектом удалённо через внешние каналы** — Slack, Telegram, e-mail и др.
   Из чата: поставить задачу, следить за ходом, отвечать агенту, аппрувить операции.
2. **Подключать к проекту людей и назначать им роли** — «агенты, которые являются
   людьми». Лид (PM) должен уметь делегировать работу не только AI-субагентам, но и
   человеку, дождаться его ответа и продолжить.

Это два связанных, но разных механизма: человек-агент бесполезен без канала, через
который до него дотягиваются.

---

## 2. Терминология (важно)

Слово **Provider** уже занято — это **эндпоинт модели** (Anthropic / OpenAI / DeepSeek /
Ollama через LiteLLM; см. `providers.service.ts`, `Provider` в схеме). Каналы общения — это
**другая** абстракция, и путать их нельзя.

Вводим два новых понятия:

| Понятие | Что это | Аналог в текущем коде |
|---|---|---|
| **Channel** | Двунаправленный транспорт сообщений: Slack workspace/канал, Telegram bot/chat, e-mail. Строка в БД с конфигом + секретами + CRUD + менеджер в Settings. | `McpServer`, `Provider` |
| **Participant** | Обобщение сегодняшнего «агента». Вид `ai` (запускается через `runAgent`) или `human` (человек, достижимый через канал). Роль (pm/designer/…) сохраняется. | `AgentDef` (`agent-registry`) |

---

## 3. Текущая архитектура (то, на что опираемся)

Вся коммуникация проходит через **один хаб** — `AgentEventBus` (in-process pub/sub,
`bus/agent-event-bus.ts`). Сейчас единственный потребитель — `EventsGateway`
(`events/events.gateway.ts`), который транслирует события в Socket.IO-комнаты
(`global` + `task:<id>`).

**Входящие действия человека** — REST-контроллеры:

- `POST /tasks` — создать задачу (`tasks.service.ts:48`).
- `POST /tasks/:id/follow-up` — **это и есть «ответить агенту»**: резюмит Claude-сессию
  (`resumeSessionId`) новым промптом (`tasks.service.ts:84`, `real-agent-executor.ts:100`).
  Разрешён только на терминальной задаче.
- `POST /approvals/:id/decision` c полем `decidedBy` — вердикт по опасному вызову
  (`approvals.controller.ts:49`).

**Approval-гейт уже умеет блокироваться и ждать внешнего решения** через long-poll
(`approvals.controller.ts:26`, `waitForVerdict`). Это готовый паттерн
«затормозить → ждать человека → продолжить», который мы переиспользуем для людей-агентов.

**События шины** (`events.gateway.ts:52`):

| Событие | Payload | Источник |
|---|---|---|
| `agent-log` | строка транскрипта (kind, text, seq, attachments) | executor `onEvent` |
| `agent-status` | статус сессии | executor |
| `task-status` | смена статуса задачи | `tasks.setStatus()` |
| `task-upserted` / `task-deleted` | задача | tasks service |
| `approval-created` / `approval-resolved` | аппрув | approvals service |

**Делегирование:** лид (task `agentName` или дефолтный `pm`) получает остальных
зарегистрированных агентов как субагентов (`real-agent-executor.ts:283`, `buildSubagents`),
каждый на своём провайдере/маршруте LiteLLM. Делегирование идёт через встроенный
**Task tool** (`SendMessage` заблокирован — `real-agent-executor.ts:195`).

**Единственная исходящая интеграция сегодня** — `GitHubService.publishResult()`
(`worktrees/github.service.ts:34`): пуш ветки + открытие PR. Best-effort. Новые каналы
уведомлений — это то, чего пока нет.

> **Ключевое наблюдение:** и «чат с агентом» (follow-up), и «человек разблокирует задачу»
> (approval wait) — уже существуют. Каналы и люди-агенты строим **поверх** них.

---

## 4. Предлагаемая модель данных

Новые модели Prisma (`apps/orchestrator/prisma/schema.prisma`):

```prisma
// Двунаправленный транспорт сообщений.
model Channel {
  id        String   @id @default(cuid())
  name      String   @unique
  kind      String   // 'slack' | 'telegram' | 'email'
  config    Json     // токены/секреты, id воркспейса/бота, дефолтный чат
  enabled   Boolean  @default(true)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  threads   ChannelThread[]
}

// Привязка задачи к треду в канале (одна задача = один тред).
model ChannelThread {
  id               String  @id @default(cuid())
  channelId        String
  channel          Channel @relation(fields: [channelId], references: [id], onDelete: Cascade)
  taskId           String
  externalThreadId String  // ts треда Slack / message_thread_id Telegram / Message-ID письма
  createdAt        DateTime @default(now())

  @@unique([channelId, externalThreadId])
  @@index([taskId])
}

// Внешний пользователь + его права (фундамент авторизации).
model ChannelUser {
  id             String   @id @default(cuid())
  channelId      String
  externalUserId String   // U0123 (Slack) / tg id / email
  displayName    String?
  // права: что этому человеку можно делать через канал
  canCreateTasks Boolean  @default(false)
  canApprove     Boolean  @default(false)
  canFollowUp    Boolean  @default(false)
  // если это человек-исполнитель — ссылка на participant-роль
  participant    String?  // имя human-агента, которого он «отыгрывает»
  createdAt      DateTime @default(now())

  @@unique([channelId, externalUserId])
}
```

Точечные расширения существующих моделей:

```prisma
model Task {
  // ...
  createdByChannel String?  // "slack:U0123" — кто извне поставил задачу
}

// resolvedBy у ApprovalRequest уже есть — пишем туда "slack:U0123".
```

**Люди-агенты** — расширяем `AgentDef` (frontmatter `./agent/agents/<name>.md`), не БД,
чтобы остаться в единой модели агентов:

```yaml
---
name: reviewer-human
description: Живой ревьюер, отвечает в Slack
kind: human            # NEW: 'ai' (default) | 'human'
channel: slack-main    # NEW: через какой канал слать запрос
recipient: U0123       # NEW: кому именно
---
Ты — живой участник. Оркестратор пришлёт тебе запрос в Slack; твой ответ вернётся агенту.
```

---

## 5. Точки интеграции (по направлениям)

### 5.1. Исходящее (агент → канал) — Фаза 1

Новый `ChannelNotifierService` подписывается на шину **ровно как gateway**:

```ts
// channels/channel-notifier.service.ts
@Injectable()
export class ChannelNotifierService implements OnModuleInit {
  constructor(private readonly bus: AgentEventBus, private readonly channels: ChannelsService) {}
  onModuleInit() { this.bus.subscribe((e) => this.dispatch(e)); }  // ср. events.gateway.ts:30

  private async dispatch(e: BusEvent) {
    switch (e.type) {
      case 'task-status':       return this.channels.postStatus(e.payload);
      case 'approval-created':  return this.channels.postApproval(e.payload.approval); // + кнопки
      case 'approval-resolved': return this.channels.updateApproval(e.payload);
      case 'agent-log':         return; // по умолчанию НЕ шлём — слишком шумно (см. §7)
    }
  }
}
```

Что уходит наружу: смена статуса, запрос аппрува (с кнопками Approve/Deny), финальный
результат + `prUrl`. Транскрипт `agent-log` по умолчанию не шлём (шум + rate limits).

### 5.2. Входящее (канал → оркестратор) — Фаза 2

Новый `ChannelsModule` с адаптерами-контроллерами (Slack Events API / Telegram webhook):

- Сообщение в новом треде → `tasks.create()` (агент из конфига канала).
- Ответ в треде задачи (по `ChannelThread`) → `tasks.followUp()`.
- Нажатие кнопки на сообщении-аппруве → `approvals.decide(id, decision, "slack:U0123")`.

Требования: **идемпотентность** (Slack/TG ретраят вебхуки — дедуп по event_id/update_id),
проверка подписи запроса, маппинг внешнего пользователя → `ChannelUser` → права.

### 5.3. Люди-как-агенты — Фаза 3

AI-агент выполняется синхронно через `runAgent`; человек так не запускается. Решение —
переиспользовать существующие паттерны:

1. **Делегирование человеку = MCP-инструмент.** Лиду выдаётся инструмент `ask_human` /
   `assign_to`, который оркестратор перехватывает → постит запрос в канал человека →
   возвращает его ответ как результат вызова инструмента. Ложится на текущий MCP-механизм
   (`mcp.service.ts`, per-agent `mcp`), НЕ требует нового транспорта делегирования.
2. **Ожидание ответа = новый статус `waiting_human`** (по аналогии с `needs_approval`).
   Задача паркуется; ответ человека из канала фидится обратно (tool-result / follow-up) →
   задача продолжается. Механика 1:1 повторяет approval long-poll
   (`approvals.controller.ts:26`).

```
Лид (AI) --ask_human--> оркестратор --пост в Slack--> человек
                            ↑                            |
                    task=waiting_human            отвечает в треде
                            |                            ↓
       tool_result <---- оркестратор <---- ChannelsController (inbound)
                            |
                   задача продолжается
```

---

## 6. Авторизация (главный риск)

Сегодня auth/RBAC **явно вне scope v1** (README). Внешние каналы открывают входящую
атак-поверхность: любой, кто пишет боту, потенциально создаёт задачи и аппрувит опасные
операции (Bash, Write и т.п.).

**До включения входящего управления обязателен** per-channel allowlist пользователей с
правами (`ChannelUser`: `canCreateTasks` / `canApprove` / `canFollowUp`). Неизвестный
внешний пользователь → игнор. Это не «приятное дополнение», а предусловие Фазы 2.

Дополнительно: проверка подписи вебхуков (Slack signing secret, Telegram secret token),
секреты каналов — как секреты провайдеров (маскируются в API-ответах).

---

## 7. Открытые вопросы / решения

- **Модель тредов:** одна задача = один тред. Как быть с параллельными задачами одного
  пользователя в одном чате Telegram (нет нативных тредов)? → префикс `#<taskId>` в тексте
  или отдельные сообщения-«якоря».
- **Шум транскрипта:** `agent-log` многословен. По умолчанию не шлём; опция «verbose» на
  канал. Возможно — сжатая сводка шагов вместо сырых токенов.
- **Вложения из каналов:** скачать из Slack/TG → `AttachmentsService.save()` → передать
  имена в create/follow-up DTO (агент читает через Read tool).
- **Гонки:** `followUp` разрешён только на терминальной задаче (`tasks.service.ts:88`).
  Из канала «ответ, пока агент ещё работает» надо буферизовать или отклонять с понятным
  сообщением.
- **Идентичность в транскрипте:** сейчас нет модели `User`; `resolvedBy`/`createdByChannel`
  как лёгкий зачаток. Нужна ли полноценная модель пользователя — решить до Фазы 3.

---

## 8. План внедрения

| Фаза | Что | Риск | Изменения |
|---|---|---|---|
| **1. Outbound-зеркало** | Задача зеркалится в тред канала (статусы, аппрувы, результат, PR). Только чтение. | Низкий | `Channel` + `ChannelThread` + подписчик на шину + менеджер в Settings |
| **2. Inbound-управление** | Ответ в треде → follow-up; кнопки → approval; создание задачи из чата | Средний | `ChannelUser` + allowlist + проверка подписи + идемпотентность + парсинг команд |
| **3. Люди-агенты** | Human-participant, статус `waiting_human`, MCP-tool `ask_human`/`assign_to`, роутинг назначений | Высокий | `AgentDef.kind=human` + новый статус + hold/resume механика |

Фаза 1 даёт ценность почти сразу и почти не трогает домен — с неё и начинаем.

---

## 9. Новые файлы (ориентир)

```
apps/orchestrator/src/channels/
├── channels.module.ts              # регистрируется в app.module.ts
├── channels.service.ts             # CRUD каналов + форматирование/отправка
├── channels.controller.ts          # CRUD API (секреты маскируются)
├── channel-notifier.service.ts     # подписка на AgentEventBus → outbound (Фаза 1)
├── channel-thread.service.ts       # маппинг task ↔ тред
├── slack/
│   ├── slack.adapter.ts            # формат сообщений/кнопок, вызовы Slack API
│   └── slack.controller.ts         # входящие вебхуки (Фаза 2): events, actions
└── telegram/
    ├── telegram.adapter.ts
    └── telegram.controller.ts      # входящий webhook (Фаза 2)
```
