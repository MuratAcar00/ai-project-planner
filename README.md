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

`ExecutionService` checks task dependencies, persists task lifecycle fields and result/error data, and records each attempted execution as a run. Two execution providers are available:

```text
ExecutionProvider
├── TemplateExecutionProvider
└── CodexExecutionProvider
```

- `template` is the default provider. It is deterministic and never runs code or calls an AI service.
- `codex` runs the locally installed Codex CLI non-interactively for one task inside that project's controlled workspace. It passes task details as prompt data, collects bounded stdout/stderr, and records exit code, signal, timeout, and success state in the task run.

## Background execution lifecycle

`POST /api/projects/:id/tasks/:taskId/run` persists a running Run and Task and returns **202 Accepted** with `{ task, run, blocked: false }`, without waiting for the provider. Poll `GET /api/projects/:id/runs` by the returned run ID; retrieve the project for the latest task state. Provider failures appear in the stored run/task, not in the already completed POST response. Blocked dependencies and duplicate active task executions return 409.

A small in-process job map owns execution independently of the HTTP connection. Successful jobs persist `completed`; rejected promises, exceptions and timeouts persist `failed` with an error and completion timestamp. Codex failures retain process details under `run.error.output` and `task.result`. The provider's own timeout terminates Codex; a separate 65-minute service deadline bounds even providers or workspace resolution that never settle. Late results cannot overwrite a terminal state.

JSON repository operations are serialized and file replacement is atomic, avoiding lost updates between concurrent jobs. Terminal writes retry transient errors three times. A persistent storage outage cannot guarantee a durable terminal state; the server emits only a generic persistence diagnostic. Startup recovery marks interrupted running executions/tasks as failed before API requests are served, without rerunning Codex. Jobs do not survive server shutdown and are not resumed. Run one server process with one repository instance per data file; this is not a distributed queue or cross-process lock.

## Codex task execution

To select Codex for a task, call the existing run endpoint with an explicit provider:

```json
{ "provider": "codex" }
```

The child uses `stdio: ['ignore', 'pipe', 'pipe']`: the positional prompt is the entire input, stdin receives immediate EOF, and stdout/stderr are captured. The installed CLI also reads piped stdin when a positional prompt is supplied, so leaving the default stdin pipe open can prevent execution from starting.

The provider tracks process `exit` separately from `close`. Exit cancels the execution timer and allows up to one second for output pipes to close; otherwise the run fails with `terminationReason: "stdio_timeout"` and `outputIncomplete: true`. Timeout and process/stream errors request SIGTERM, then attempt SIGKILL after a five-second grace period if the process has not exited. A single settlement guard preserves the first terminal outcome and releases timers and local output pipes. These signals target the immediate child process, not an entire descendant process tree.

Result metadata distinguishes observed `exitCode`/`signal` from `timedOut`, `terminationReason`, and `requestedSignal`. A process can return exit code zero after termination was requested; that does not undo a job timeout. Failed signaling never invents an observed signal. The previous real execution's stderr was `Reading additional input from stdin...`, with empty stdout and a 600000ms timeout followed by exit code zero. This strongly identifies the unclosed stdin pipe as the cause; the old result did not record exit/close timestamps, so their exact ordering cannot be reconstructed. No real Codex task was run to validate this fix; tests use mocked children and a local Node EOF fixture.

The application invokes the installed CLI as `codex --ask-for-approval never exec` using its `workspace-write` sandbox and a fixed argument list. In this CLI version, the approval policy is a root `codex` option and must appear before the `exec` subcommand. It does not expose arbitrary command execution through the API. Codex must be installed and available on the server's `PATH`; otherwise the run is persisted as failed with `Codex CLI is not installed or not available in PATH.`

Each project is mapped to `workspaces/<projectId>` by default. Set `PROJECT_WORKSPACE_ROOT` to an absolute, application-controlled directory to use another root. Project IDs are validated and resolved paths are checked after creation, preventing traversal and symlink escapes from the workspace root. The API never accepts a workspace path.

`CODEX_EXECUTION_TIMEOUT_MS` configures the Codex timeout in milliseconds (default: 600000, maximum: 3600000). A timed-out process is terminated. `CODEX_EXECUTION_OUTPUT_LIMIT` bounds each captured stdout and stderr stream (default: 65536 characters; maximum: 1048576); truncated output is marked in the stored result. The provider deliberately does not log process output to the server console.

The generated prompt confines Codex to the assigned task and workspace, prohibits access to `.env`, secrets, credentials, or files outside the workspace, and prohibits dependency installation, `sudo`, destructive operations, commits, pushes, GitHub operations, and deployment. Do not place secrets in a project workspace.

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
- `src/services/workspace-service.js` — controlled project-workspace resolution
- `src/providers/codex-execution-provider.js` — bounded, non-interactive local Codex CLI adapter
- `src/domain.js` — Project, Requirements, Plan, Phase, Task, and Run factories
- `src/repositories/` — project repository contract and JSON implementation
- `src/store.js` — backwards-compatible JSON store export
- `src/validation.js` — request validation rules
- `public/` — responsive HTML, CSS, and browser JavaScript
- `data/` — runtime project data
- `test/api.test.js` — API integration tests
- `test/execution.test.js` — isolated task-execution service and API tests
- `test/codex-execution.test.js` — mock-based Codex provider, workspace, timeout, and output tests

## Future improvements

- User accounts and authorization.
- SQLite or hosted database storage with safe concurrent writes.
- Editable/reorderable plan tasks and custom phases.
- AI-provider integration as an optional planning engine.
- Export plans to Markdown/PDF and project-management integrations.
