# AI Project Planner

AI Project Planner turns a software idea into a structured, actionable development plan. It is a fully local Express application: plans are generated deterministically from practical templates, and projects persist in a JSON file—no external AI service or database is required.

## Features

- Validated project creation: name, description, target platform, technology, and experience level.
- Rule-based plans with overview, architecture, stack guidance, four development phases, task estimates, difficulty, testing strategy, and deployment checklist.
- Dashboard with status, task counts, progress, and creation date.
- Detail page with interactive task completion and calculated progress.
- REST API with helpful validation, 404, and server-error responses.
- Responsive, framework-free interface for desktop and mobile.
- Local JSON persistence at `data/projects.json` (created automatically).

## Architecture

The browser is a small vanilla JavaScript single-page interface using hash routes. It calls an Express JSON API. The API validates inputs, passes valid projects through an asynchronous planner service, and writes the resulting project document through a repository abstraction backed by a JSON file.

`public UI → Express REST API → project service → planner provider + project repository → JSON data file`

Projects preserve the original `plan.phases[].tasks[]` structure and now also contain a requirements record and planning runs. The default `TemplatePlannerProvider` is deterministic and does not call an external AI service. Future AI or Codex providers can implement the same asynchronous planner-provider contract without changing the API or frontend.

Task execution follows a separate, provider-backed flow:

```text
Project
  ↓
Task
  ↓
ExecutionService
  ↓
ExecutionProvider
  ↓
Run
```

`ExecutionService` checks task dependencies, persists task lifecycle fields and result/error data, and records each attempted execution as a run. The default provider is fully deterministic and does not execute code or call an AI service. It can later grow as:

```text
ExecutionProvider
├── TemplateExecutionProvider
└── CodexExecutionProvider
```

## Installation

Requires Node.js 18 or newer.

```bash
npm install
```

## Run the application

```bash
npm start
```

Open http://localhost:3000. For development with automatic server restarts:

```bash
npm run dev
```

## Testing

```bash
npm test
```

Tests use Node’s built-in test runner and a temporary JSON data file, so they never alter your application data.

## API

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Basic service health response |
| `GET` | `/api/projects` | List projects with task summaries |
| `POST` | `/api/projects` | Create a project and plan |
| `GET` | `/api/projects/:id` | Retrieve a project and full plan |
| `PATCH` | `/api/projects/:id/tasks/:taskId` | Update controlled task fields, including `{ "completed": true/false }` or `status` |
| `POST` | `/api/projects/:id/tasks/:taskId/run` | Execute a task through the selected provider (default: `template`) |
| `GET` | `/api/projects/:id/runs` | List planning and task-execution runs |
| `DELETE` | `/api/projects/:id` | Delete a project |

`POST /api/projects` expects `name`, `description`, `platform`, `technology`, and `experienceLevel` strings. Example platforms: `Web`, `Mobile`, `Desktop`, `API / Backend`; technologies: `JavaScript`, `TypeScript`, `Python`, `Java`, `C#`, `Other`; experience levels: `Beginner`, `Intermediate`, `Advanced`.

## Project structure

- `src/app.js` — Express routes and error handling
- `src/server.js` — server startup
- `src/planner.js` — deterministic plan generator used by the template provider
- `src/providers/` — planner-provider implementations
- `src/services/` — planner, project, and execution application services
- `src/domain.js` — Project, Requirements, Plan, Phase, Task, and Run factories
- `src/repositories/` — project repository contract and JSON implementation
- `src/store.js` — backwards-compatible JSON store export
- `src/validation.js` — request validation rules
- `public/` — responsive HTML, CSS, and browser JavaScript
- `data/` — runtime project data
- `test/api.test.js` — API integration tests
- `test/execution.test.js` — isolated task-execution service and API tests

## Future improvements

- User accounts and authorization.
- SQLite or hosted database storage with safe concurrent writes.
- Editable/reorderable plan tasks and custom phases.
- AI-provider integration as an optional planning engine.
- A `CodexExecutionProvider` that performs real agent execution behind the existing execution-provider contract.
- Export plans to Markdown/PDF and project-management integrations.
