# devteam-board

Jira-подобный веб-интерфейс для одновременного запуска нескольких конвейеров **devteam** (qwencode) с отображением статуса по каждой стадии, изоляцией через worktree-на-тикет и фронтендом, работающим только на опросе (polling-only).

> **v0.1.0 — MVP, single-user, local-only.** Архитектурный паттерн заимствован из [smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad): один процесс-супервайзер владеет состоянием, по одному подпроцессу `qwen` на тикет, каждому тикету выделяется собственный git worktree.

## Что он делает

- Запускает `qwen -p "/devteam:build --feature X --base main --no-push"` на каждый тикет
- Создаёт свежий `git worktree add -b <branch> <path> <base>` для каждого тикета (параллельные конвейеры в одном репозитории не конфликтуют на уровне `.git/index`)
- Разбирает emit-строки в stdout (`STAGE N COMPLETED`, `TASK_COMPLETE`, `HITL_PAUSED`, `ADMIN_COMPLETED`, …), чтобы обновлять стадию тикета
- Следит за `.devteam/plans/<plan-id>/*.md`, чтобы показывать артефакты `analysis.md` и `stage2.merge.md` в UI
- Отдаёт канбан на 7 колонок (Backlog / Analytics / Development / Testing / Admin / Done / Failed) по адресу `http://localhost:3000`
- Браузер каждые 2 секунды опрашивает `/api/tickets` — никаких WebSocket и SSE

## Чего он пока НЕ делает

- HITL-одобрение в середине конвейера (`ask_user_question` в devteam интерактивен; в неинтерактивном режиме qwen мы трактуем HITL только как pre-flight)
- Мультипользовательский режим / авторизация
- Уведомления (email / Slack / Telegram)
- Стриминг логов в реальном времени (логи буферизуются, опрос каждые 1.5s в модалке деталей)
- Авто-merge завершённых веток из worktree обратно в основной репозиторий
- WebSocket / SSE (не нужны; для канбан-UX опроса достаточно)

## Установка и запуск

```bash
cd ~/Desktop/devteam-board
npm install
npm start            # http://localhost:3000
```

### Предусловия

`qwen` должен быть установлен **и** настроен на неинтерактивную работу на этой машине. Доска запускает `qwen -p "..."` и полагается на то, что он работает headless. Проверьте так:

```bash
qwen --version                     # должна вывестись версия
echo '' | qwen -p "say hi" -y      # должен отработать и завершиться (без ошибки "no auth")
```

Если видите `No auth type is selected. Please configure an auth type...`, выполните `qwen auth` (или отредактируйте `~/.qwen/settings.json`) и повторите проверку. Доска пометит любой тикет, чей дочерний процесс qwen умрёт в течение ~2s, как `failed` с занесённым в буфер логов stderr — обычно причина именно в этом.

## Использование

1. Нажмите **+ New ticket**
2. Заполните:
   - **Title** — описание фичи, передаётся в `/devteam:build --feature`
   - **Repo path (workdir)** — путь к git-репозиторию, с которым должен работать конвейер. Поле выпадающим списком предлагает поддиректории из `PROJECTS_ROOT` (по умолчанию — родительская директория самой доски), отфильтрованные по наличию `.git`; сам каталог доски из списка исключён. Можно ввести путь вручную.
   - **Base branch** — по умолчанию `main`
   - **Branch name** — необязательно, автогенерируется из заголовка
   - **Stay on current branch** — если отмечено, новая ветка не создаётся: worktree создаётся в detached-режиме на `base` (полезно для разовых запусков, не требующих изоляции ветки)
3. Доска создаёт worktree (например, `/Users/me/projects/api-devteam-board-add-oauth-login-t-abc12345`) и запускает внутри него процесс `qwen`
4. Карточка появляется в колонке **Analytics** и перемещается по колонкам по мере поступления emit-строк
5. Кликните по карточке, чтобы увидеть живые логи, таймлайн стадий и файлы `analysis.md` / `stage2.merge.md`
6. Используйте **Cancel**, чтобы отправить SIGTERM процессу qwen (worktree сохраняется), или **Delete**, чтобы убить процесс и удалить worktree

## Структура проекта

```
devteam-board/
├── package.json
├── README.md
├── .gitignore
├── src/
│   ├── board.js          # точка входа: HTTP + супервайзер
│   ├── db.js             # обёртка над lowdb (board.json)
│   ├── worktree.js       # менеджер git worktree
│   ├── pipeline.js       # запуск qwen, парсинг stdout
│   ├── emit-parser.js    # паттерны STAGE N / TASK_COMPLETE / HITL_PAUSED
│   ├── projects.js       # сканер git-репозиториев для dropdown workdir
│   └── hitl.js           # мост чтения/записи pre-flight HITL
└── public/
    ├── index.html        # канбан на 7 колонок
    ├── app.js            # vanilla-JS клиент на опросе
    └── style.css         # тёмная тема
```

## API

| Метод | Путь | Назначение |
|---|---|---|
| `GET` | `/api/health` | liveness + количество тикетов |
| `GET` | `/api/projects` | список git-репозиториев под `PROJECTS_ROOT` для dropdown workdir |
| `GET` | `/api/tickets` | список всех тикетов (опрашивается UI) |
| `GET` | `/api/tickets/:id` | полная информация о тикете |
| `GET` | `/api/tickets/:id/logs?since=N` | инкрементальный буфер логов |
| `POST` | `/api/tickets` | `{title, workdir, base?, branch?, noNewBranch?}` → создаёт worktree + запускает qwen. `noNewBranch: true` создаёт detached worktree на `base` без новой ветки |
| `POST` | `/api/tickets/:id/cancel` | SIGTERM, worktree сохраняется |
| `POST` | `/api/tickets/:id/hitl` | `{decision: "approve"\|"reject", comment?}` |
| `DELETE` | `/api/tickets/:id` | SIGTERM + удаление worktree |

## Конфигурация

| Переменная окружения | По умолчанию | Назначение |
|---|---|---|
| `PORT` | `3000` | HTTP-порт |
| `BOARD_FILE` | `./board.json` | файл состояния lowdb |
| `PROJECTS_ROOT` | `<родитель репозитория доски>` | корневая директория, из которой `/api/projects` собирает поддиректории для выпадающего списка workdir. Сам каталог доски из списка исключён; в списке остаются только директории, содержащие `.git` |

## Как потребляется контракт devteam

Оркестраторы devteam пишут в stdout эти строки (см. `agents/pipeline-orchestrator.md`, `agents/git-admin-developer.md`). В `src/emit-parser.js` мы матчим их по паттернам:

| Emit-строка | Эффект на тикет |
|---|---|
| `STAGE 1 STARTED` | `status=running`, `stage=analytics` |
| `STAGE 1 COMPLETED` / `ANALYTICS_COMPLETED` | `stage=analytics` попадает в `stagesCompleted` |
| `STAGE N STARTED` | `stage=<эта стадия>` |
| `[substage] kotlin-api-developer` | `substage=kotlin-api-developer` |
| `STAGE N FAILED` | `status=failed`, `failureReason` |
| `HITL_PAUSED: <reason>` | `status=awaiting_approval` |
| `ADMIN_COMPLETED` | `status=completed` |
| `TASK_COMPLETE: <id>` | `status=completed` |
| завершение дочернего процесса с `code!=0` | `status=failed`, метаданные exit-кода |

## Roadmap

- [ ] HITL в середине конвейера (заменить pre-flight файловым каналом, который кормит `ask_user_question` в интерактивном режиме, либо научить devteam читать `.devteam/hitl/<id>.json`)
- [ ] Авто-merge завершённых веток из worktree обратно в базовую
- [ ] Действие `open in editor` на тикет
- [ ] Персистентный лог-в-файл (переживает смерть процесса)
- [ ] Мультипользовательский режим / авторизация
- [ ] Уведомления (Slack / Telegram / email)
- [ ] Опциональный мост в Jira (write-back через существующий `sooperset/mcp-atlassian`)
