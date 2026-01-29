## SX3 Master Plan — новая чистая платформа мультиагентной разработки

Этот документ фиксирует целевую архитектуру SX3, нейминг‑конвенции, контракты и **поэтапный** план реализации.

### Принципиальные цели SX3

- **Развести “процесс выполнения” и “артефакт доставки”**: нельзя считать задачу сделанной по state/ветке; истина — delivery.
- **Убрать веткоцентричность**: ветки остаются implementation detail, но не контрактом системы.
- **Атомарность**: checkpoint = одна транзакция (integrate → publish → verify → sync) или отказ без опасных полумер.
- **Наблюдаемость по умолчанию**: watch/doctor/repair — это штатные команды первого класса.
- **Машиночитаемость**: все ошибки возвращают `stage/reason/next_step_cmd`, вывод поддерживает `min-json|jsonl`.
- **SX2 остаётся рабочей системой**: SX3 живёт рядом и не ломает SX2.

---

## 1) Ключевая концепция (простыми словами)

SX3 строится вокруг строгого факта:

- **Attempt (попытка)**: исполнитель выполняет задачу на базе `base_sha` и производит изменения.
- **Publish**: результат упаковывается в patch‑bundle и кладётся в **Patch Store**.
- **Delivery**: опубликованный результат (patch + deliverables + мета).
- **Accept**: приёмка работает с delivery (apply patch → checks → integrate).
- **Checkpoint**: одна транзакция гарантирует, что `origin/session/<id>` обновлён и ворктри синхронизированы к конкретному `session_head_sha`.

В SX3 “DONE” = “есть delivery + принято + чекпоинт”.

---

## 2) Storage: SQLite как источник истины

В SX3 состояние и история — в SQLite (а не в разрозненных json‑файлах).

### 2.1 Таблицы (v1, минимальный набор)

- **`sessions`**
  - `id`, `project_id`, `status`, `created_at`, `closed_at`, `meta_json`
- **`plans`**
  - `id`, `session_id`, `created_at`, `selector_json` (allowlist), `assigns_json`
- **`attempts`**
  - `id`, `session_id`, `issue_id`, `worktree`, `status`
  - `base_sha`, `result_sha` (если применимо), `started_at`, `finished_at`
  - `pid`, `heartbeat_at`, `exit_code`, `ok`
  - `deliverables_json`, `diagnostics_json`
- **`deliveries`**
  - `id`, `attempt_id`, `status`, `created_at`
  - `patch_uri`, `patch_sha256`, `patch_size`
  - `deliverables_json`, `summary_json`
- **`check_runs`**
  - `id`, `delivery_id`, `status`, `started_at`, `finished_at`, `ok`, `report_json`, `log_uri`
- **`checkpoints`**
  - `id`, `session_id`, `status`, `started_at`, `finished_at`
  - `session_head_sha_local`, `session_head_sha_remote`, `synced_worktrees_json`, `report_json`
- **`events`** (append‑only)
  - `id`, `ts`, `kind`, `session_id`, `attempt_id`, `delivery_id`, `checkpoint_id`, `payload_json`
- **`worktrees`**
  - `id` (worktree name), `project_id`, `path`, `state_json` (detected), `last_seen_at`

### 2.2 Инварианты SQLite

- Любое действие создаёт событие в `events`.
- Статусы не “угадываются” по тексту: **фиксируются**.
- Для watch/doctor достаточно одного SQL‑запроса к последнему состоянию.

---

## 3) Publish strategy v1: Patch Store

### 3.1 Почему Patch Store

- Убираем зависимость от “ветка в origin обязана существовать”.
- Убираем `push.ref_missing`/`push.out_of_date` как массовый класс проблем.
- Приёмка работает по **контенту (patch)**, а не по имени ветки.

### 3.2 Контракт Patch Store

Операции:
- `put(bundle_bytes, metadata) -> { uri, sha256, size }`
- `get(uri) -> bytes/stream`
- `verify(uri) -> ok`
- `gc(policy) -> report`

### 3.3 Формат patch bundle (v1)

Минимальный надёжный формат:
- архив (zip/tar) с файлами:
  - `meta.json`:
    - `schema_version`
    - `project_id`, `session_id`, `attempt_id`, `issue_id`
    - `base_sha`
    - `created_at`
  - `patch.diff` (unified diff)
  - `stats.json` (опционально)
  - `deliverables.json` (копия)

---

## 4) Контракты системы (обязательные)

### 4.1 Machine output contract

Любая команда SX3 в режиме `--format min-json` возвращает:
- `schema_version`
- `kind`
- `ok`
- `stage` (если ok=false)
- `reason`
- `next_step_cmd`
- `details` (объект; необязателен)

### 4.2 Deliverables contract (v1)

`deliverables.json` обязан содержать:
- `schema_version: 1`
- `issue_id: "L-000123"`
- `summary: string[]` (непустой)
- `changed_files: string[]` (непустой)
- `how_to_verify: string[]` (непустой)
- `risks: string[]` (может быть пустым)

Если deliverables невалиден → attempt/delivery не может стать “published/accepted”.

### 4.3 Heartbeat contract

- Heartbeat пишется **runner’ом** (SX3), а не зависит от LLM‑вывода.
- Heartbeat период `N` — configurable (по умолчанию 15s).

### 4.4 Repair policy contract (divergence)

Везде одна политика:
- **ahead-only** → auto publish / fast push (если применимо)
- **behind-only** → auto reset к целевому источнику (safe)
- **diverged** → stop + “один экран” диагностики + чёткий рецепт

---

## 5) Нейминг и структура команд (канон SX3)

### 5.1 Общие правила

- Команда = `<object> <verb>`
- Глаголы: `open|close|status|list|show|run|publish|accept|checkpoint|watch|repair|tail`

### 5.2 Базовые команды (MVP)

- `sx3 session open|status|close`
- `sx3 plan build` (строит план из allowlist + assigns; формат backlog не меняем)
- `sx3 attempt run|list|show|tail|cancel`
- `sx3 delivery list|show`
- `sx3 accept run`
- `sx3 checkpoint run`
- `sx3 watch` / `sx3 watch --format jsonl`
- `sx3 repair worktree <wt>` / `sx3 repair attempt <id>`
- `sx3 db migrate|status`
- `sx3 store put|get|verify|gc`

### 5.3 Единые флаги

- `--dry-run | --apply` (везде)
- `--format human|min-json|jsonl` (везде)
- `--project <id>` / `--session <id>` (где уместно)

---

## 6) Архитектура модулей SX3 (чистая)

### 6.1 CLI слой

- парсинг аргументов
- форматирование вывода
- вызов core

### 6.2 Core слой

- `attempt-manager`
- `runner` (LLM/executor runtime + heartbeat)
- `publisher` (patch bundle + store)
- `gates` (deliverables + no-op + publish)
- `acceptance-engine` (apply patch + checks + integrate)
- `checkpoint-engine` (integrate→publish→verify→sync)
- `policy-engine` (repair rules)

### 6.3 Storage слой

- SQLite (migrations, queries)
- Patch Store (локальный backend v1; позже S3/MinIO)

---

## 7) Пошаговый план реализации (PR-by-PR)

### Этап 0 — Workspace + “чистый repo” SX3

DoD:
- repo `sx3-platform` создан
- `sx3 help` работает

### Этап 1 — SQLite schema + migrations

DoD:
- `sx3 db migrate` поднимает БД
- `sx3 db status` показывает версию

### Этап 2 — Patch Store v1 (локальный)

DoD:
- `sx3 store put/get/verify`
- bundle format v1

### Этап 3 — Attempt runner + heartbeat

DoD:
- `sx3 attempt run` создаёт attempt, пишет heartbeat, завершает attempt с фактами

### Этап 4 — Publish → Delivery

DoD:
- после успеха создаётся delivery с `patch_uri`
- без publish нельзя стать “готовым”

### Этап 5 — Gates + Deliverables v1

DoD:
- deliverables обязательны и валидируются

### Этап 6 — Acceptance engine

DoD:
- apply patch → checks → integrate
- идемпотентность повторных запусков

### Этап 7 — Checkpoint engine (атомарный)

DoD:
- sync запрещён без remote-confirm
- safe sync while agents working (only _main)

### Этап 8 — Watch/Doctor/Repair

DoD:
- одна команда `sx3 repair ...` чинит stuck и печатает хвост логов/рецепт

---

## 8) Совместимость с SX2 (жёсткое правило)

- SX2 платформа **не меняется** от появления SX3.
- SX3 разрабатывается в отдельном репозитории (`sx3-platform`).
- Проекты будут переноситься постепенно в `projects/`, это отдельная миграция.
