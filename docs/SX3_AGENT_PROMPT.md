## SX3 Agent Prompt (Builder) — контекст, правила, что делать дальше

Ты — агент-исполнитель, который продолжает работу в новом workspace на HDD.

### 0) Где мы находимся (важно)

Диск SYMDEV смонтирован в `/mnt/dev.sdc2` (ext4). Структура:

- `/mnt/dev.sdc2/dev/` — рабочие репозитории/ворктри
  - `symmetry/` (legacy worktrees)
  - `symmetry-platform/` (SX2 платформа)
- `/mnt/dev.sdc2/Symmetry Workspace/` — **workspace-repo** для SX3 (это git‑репо)
  - `sx2-platform` — symlink на `/mnt/dev.sdc2/dev/symmetry-platform`
  - `legacy-worktrees` — symlink на `/mnt/dev.sdc2/dev/symmetry`
  - `sx3-platform/` — место для новой чистой платформы SX3
  - `projects/` — место для будущих проектов
  - `docs/` — документация (включая master plan)

В `~/dev` остались только symlink’и на эти пути (для совместимости).

### 1) Что было сделано ранее (история SX2 → причины SX3)

SX2 ловил системные проблемы:

- **deliverables.json** часто становился “сталым” и приводил к mismatch `issue_id`.
- **рассинхрон ветка/ref ↔ HEAD** и divergence → ощущение “пропаданий” после sync.
- **неатомарный checkpoint** (push session не гарантирован) → риск потерять видимые изменения.
- **залипание watching/heartbeat**: агент мог остаться `working`, хотя exec уже завершился.

В SX2 уже были внедрены улучшения (не перечисляй диффы; опирайся на идею):

- deliverables стал одноразовым артефактом попытки, с более строгими preflight‑проверками.
- усилены content gates/диагностика divergence.
- heartbeat отвязан от LLM‑вывода: runner/exec сам пишет heartbeat периодически.
- добавлена процедура/команда repair для stuck agents.
- добавлены guard’ы для более безопасного sync/checkpoint.

**Важно**: SX2 должен остаться рабочим. SX3 строим рядом, “в ноль”.

### 2) Решения для SX3 (зафиксированы)

- **Publish strategy (v1)**: Patch Store (delivery = patch bundle + metadata).
- **Источник истины состояния**: SQLite.
- **Формат issue/backlog**: **НЕ меняем**.
- SX3 = новая чистая платформа, без наращивания SX2.

### 3) Главная документация (обязательно прочитать)

- `docs/SX3_MASTER_PLAN.md` — канон архитектуры, контрактов, нейминга и поэтапного плана.

### 4) Жёсткие правила работы (must)

- **Никаких секретов** в коде/логах/доках.
- **SX2 не ломаем**: не делай изменения в `sx2-platform`, если это явно не требуется отдельной задачей.
- FE↔BE на одном домене, фронт ходит только через `/api/*`, `credentials: 'include'`.
- Любые изменения API/DTO — через `packages/shared` (`@smmtry/shared`) синхронно FE/BE.
- Server-side RBAC — источник правды.

### 5) Что нужно сделать (задача на ближайшие PR)

Твоя цель: начать поднимать SX3 по этапам из master plan.

Минимальная последовательность:

- Создать скелет CLI `sx3` в `sx3-platform/`.
- Поднять SQLite migrations (`sx3 db migrate/status`).
- Реализовать Patch Store v1 (локальный backend) + контракт bundle.
- Реализовать attempt runner + heartbeat, затем publish→delivery.
- Затем accept/checkpoint/repair/watch.

Для каждого этапа:

- фиксируй DoD из `docs/SX3_MASTER_PLAN.md`;
- оставляй артефакты в `sx3-platform/` и документацию в `docs/`;
- по завершении этапа обновляй план/док (коротко, по делу).

### 6) Диагностика и самопроверка (перед “готово”)

- Убедись, что работа идёт в `sx3-platform/`.
- Убедись, что `docs/SX3_MASTER_PLAN.md` актуален.
- Если что-то блокирует (права, mount, нет зависимостей) — пиши: `BLOCKED: что хотел → где упёрся → что нужно`.
