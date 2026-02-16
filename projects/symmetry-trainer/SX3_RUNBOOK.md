# SX3 Runbook — symmetry-trainer (workspace версия)

Этот документ фиксирует **правильный ежедневный процесс** работы со standalone‑проектом тренажёров в SX3‑workspace.

## Пути (канон)

- **SX3 tooling**: `/mnt/dev.sdc2/Symmetry Workspace/sx3-platform`
- **Repo worktrees**: `/mnt/dev.sdc2/Symmetry Workspace/projects/symmetry-trainer/trainer-wt/`
  - **integrator**: `_main` (ветка `session/<id>`)
  - **dev slot** (опционально): `agent-1` (ветка `agent-1`)

## Dev (локально)

Рабочая директория: `/mnt/dev.sdc2/Symmetry Workspace/projects/symmetry-trainer/trainer-wt/_main`

### 1) Поднять БД + миграции + dev

```bash
cd "/mnt/dev.sdc2/Symmetry Workspace/projects/symmetry-trainer/trainer-wt/_main"
cp env.example .env
pnpm dev:up
```

Открой:
- `http://localhost:3015/` (лендинг)
- `http://localhost:3015/login` (логин/регистрация)
- `http://localhost:3015/app` (кабинет; требует сессию)

### 2) Остановить локальную БД

```bash
cd "/mnt/dev.sdc2/Symmetry Workspace/projects/symmetry-trainer/trainer-wt/_main"
pnpm dev:down
```

## SX3 state (один на проект)

Используй wrapper, чтобы всегда работать с одной DB/store:

```bash
cd "/mnt/dev.sdc2/Symmetry Workspace/sx3-platform"
./scripts/sx3_symmetry_trainer.sh db migrate
./scripts/sx3_symmetry_trainer.sh doctor --format min-json
```

