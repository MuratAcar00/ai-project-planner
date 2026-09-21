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

## Autonomous MVP orchestration

The local autonomous API turns a template idea into a project, requirements, a dependency-ordered implementation plan, execution tasks, validation and bounded repair attempts. It does not start anything at server startup. This implementation has been tested with fake execution providers; no new SaaS was generated during this change.

```text
TemplateIdeaProvider → IdeaEvaluator → ProjectService / PlannerService
                                             ↓
                                AutonomousProjectService
                                 ↙                  ↘
                    ExecutionService           WorkspaceValidationService
                    CodexExecutionProvider     isolated fixed validation commands
                    WorkspaceService
                                 ↓
                     JsonAutonomousRunRepository
                     state, decisions, events, validation evidence
```

`IdeaProvider` is the generation contract. `TemplateIdeaProvider` returns up to three small products with target user, problem, solution, features, monetization hypothesis, complexity and estimated task count. Monetization is a future option, not an implemented payment integration. `IdeaEvaluator` stores all eight feasibility criteria, weighted scores and the selection reason. Ideas needing paid APIs, external services, more than six tasks or complexity above three are ineligible. Score ties use idea ID for deterministic selection.

The `autonomous` planner provider uses the existing `PlannerService` and `ProjectService`; manual template planning remains unchanged. Selected features become requirement items with acceptance criteria. Four sequential phases cover backend, dashboard, tests and documentation. Every task has dependencies and acceptance criteria. Autonomous project status becomes `Completed` only after validation, not merely after the last development task.

### State, persistence and concurrency

```text
idle → generating_ideas → evaluating → planning → executing → testing → completed
                                                    ↓           ↓
                                                   fixing ← failure
                                                    ↓
                                           executing or testing

Any active state → paused (explicit resume required)
Unrecoverable error or exhausted repair budget → failed + needsAttention
```

Run state, idea evaluations, validation results, repair counters and timestamped events live in ignored `data/autonomous-runs.json`; projects stay in `data/projects.json`. The run repository reuses the serialized atomic JSON collection implementation. Run only **one server process and one repository/service instance per file**. This is not a distributed scheduler or a cross-process lock. Back up both data files together.

One nonterminal autonomous run is allowed at a time, including paused runs. Concurrent start requests return the existing run with `duplicate: true`. An optional `requestId` also identifies a previous completed/failed run so retries do not create another product. Task execution always goes through the existing `ExecutionService`; there is no second Codex task runner. Manual mutation/execution/deletion endpoints reject orchestrator-owned projects with 409.

Pause is cooperative: the current execution or validation operation may settle, but no new task/validation operation is admitted afterward. The stored state becomes `paused` immediately. Resume returns 409 while that operation is still settling. Phase output already in flight may still be persisted while paused. On process restart, interrupted executions are failed by `ExecutionService` and nonterminal autonomous runs become `paused`; **nothing is automatically relaunched**. Review processes/workspace before resume, especially after abrupt host termination. Parent run IDs reconcile project-creation crash windows; stable fix task IDs reconcile repair reservations. Completed tasks/fixes are not blindly repeated. A persistent storage failure stops the worker; recovery is required before further work.

### API

All control POST requests require `Content-Type: application/json`. Cross-origin control requests are denied. These are local operator endpoints, not a public authenticated multi-tenant API: do not expose them directly to the internet.

| Endpoint | Behavior |
| --- | --- |
| `POST /api/autonomous/start` | 202 with `{run, duplicate}`; background work begins after persistence. |
| `GET /api/autonomous/:id` | Current state, decisions, validation results and events; 404 if absent. |
| `GET /api/autonomous/:id/events` | Ordered timestamped audit events. |
| `POST /api/autonomous/:id/pause` | 202; stops admission of new work, without killing the current child. |
| `POST /api/autonomous/:id/resume` | 202 after an explicit paused-run resume; 409 if still busy/not paused. |

Start body is `{}` or, for example, `{"candidateCount":3,"requestId":"my-first-run"}`. Only these two fields are supported. Candidate count is 1–3 and request ID is 1–80 letters, digits, underscores or hyphens. Shell commands, workspace paths, raw Codex arguments, environment variables, provider choice, approval flags and fix limits are rejected. Pause/resume take `{}`. Invalid input is 400, unsupported content type 415, excessive body 413, forbidden origin 403.

### Safety and operator approval

`ApprovalGate` defaults external and unknown actions to **DENY**. There are no executors for git push, production deployment, domain purchase, paid product APIs, secret mutation, arbitrary credential use, destructive filesystem operations or writes outside a project workspace. Local generation/planning/code/test/fix actions are allowlisted. The autonomous endpoints cannot grant approvals.

The installed Codex account is a credential-bearing capability. Consequently the default application will generate/evaluate/plan, then pause at `codex_execution` approval before invoking the real CLI. In the next explicitly authorized execution stage, trusted server composition can supply `new ApprovalGate({ allowCodexExecution: true })` to `createApp({ approvalGate })`. This authorizes only the existing Codex adapter/account; it does not authorize paid product APIs or any other external action. The flag is not accepted from HTTP. Unit tests instead inject a fake execution provider.

Codex retains the checkpointed workspace-write sandbox, fixed arguments, prompt restrictions and bounded execution/output. An approval policy is not an OS sandbox: its action decisions are enforced at orchestration boundaries, while generated commands depend on the installed Codex sandbox. Do not place credentials in project workspaces or treat generated code as trusted. The existing manual task API remains a separate operator-directed interface.

### Validation and failure repair

The first autonomous product contract deliberately uses **zero dependencies, CommonJS, Node's HTTP server and a plain browser client**, with no transpiler/build system. Required package scripts are `start: node src/server.js` and `test: node --test test/*.test.js`; an optional `build: node --check src/server.js` is allowed. `src/app.js` must export an unlistened `createServer()` with `GET /api/health` returning `{status:"ok"}`. Unknown package scripts, package dependencies, dependency-bearing lockfiles, symlinks and sensitive/configuration filenames fail validation before execution. Inspection limits bound file count, individual size and directory depth.

`WorkspaceValidationService` performs these fixed checks sequentially:

1. Offline `npm install` with lifecycle scripts, audits and funding disabled; npm cache/config/home are isolated.
2. `node --check` for every JavaScript source/client/test file (the syntax/build gate).
3. `node --test` with the enumerated test files; at least one passing test is required. Empty/all-skipped suites cannot complete an MVP.
4. Start `createServer()` on an ephemeral loopback port, make a real health request, and close it.

Generated tests and startup code execute only through `SandboxValidationRunner`, using Linux **Bubblewrap** at `/usr/bin/bwrap`, system Node/npm at `/usr/bin`, user namespaces, read-only system runtime mounts and one writable project mount. The host home, environment and network are not exposed. No packages are downloaded. A fresh network namespace permits the internal loopback health request while preventing external access. Each command has a two-minute timeout and bounded captured output; the sandbox process is killed on timeout. This requires an operator-provisioned Linux host that permits user namespaces. Missing/denied sandbox infrastructure causes a safe pause, never an unsandboxed fallback. No OS package was installed by this change. Validation process behavior is covered using injected fake children/runners; a real sandbox deployment check remains for the next execution stage.

Validation records contain check names, timestamps, exit status, output and error evidence. `FailureAnalyzer` classifies package-contract, syntax, test, startup and implementation errors; its advice and bounded evidence are audited. The failing check, rather than unrelated successful-check output, becomes repair context. A fix is an ordinary persisted task run by `ExecutionService`. After a task failure, a successful fix is followed by re-executing the original task before its dependents; after a validation failure, the entire validation sequence repeats. A failed fix execution stops for manual attention rather than running more product tasks.

`MAX_FIX_ATTEMPTS` is an operator environment setting (default **3**, integer **0–10**). The selected value is persisted per run. It is a total repair budget across task and validation failures, survives restart, and cannot be supplied by API clients. Budget exhaustion produces `failed`, `needsAttention: true`, `project_failed` and a project status of `Needs attention`. Recognized missing execution/sandbox infrastructure pauses without consuming the code repair budget.

### Audit and tests

Events include `idea_generated`, `idea_selected`, `project_created`, `plan_created`, `task_started`, `task_completed`, `task_failed`, `validation_started`, `validation_failed`, `failure_analyzed`, `fix_started`, `validation_passed`, `project_completed`, `project_failed`, state transitions, approval decisions, pause/resume and recovery. Each has an ordered ID, UTC timestamp, autonomous run ID and project/task/execution-run/validation IDs where applicable. Full execution results remain in the existing project run history. Audit data is local runtime data and is not committed.

`npm test` now discovers only `test/*.test.js`; generated workspace tests are intentionally excluded. Autonomous tests use temporary repositories/workspaces and fake execution/validation providers, never the real Codex CLI. New modules are `src/autonomous/state.js`, the idea/autonomous planner providers, `IdeaEvaluator`, `FailureAnalyzer`, `ApprovalGate`, `AutonomousProjectService`, `WorkspaceValidationService` and `JsonAutonomousRunRepository`. Test files are `test/autonomous.test.js`, `test/autonomous-api.test.js`, `test/autonomous-validation.test.js` and their isolated fixture helper.

### Isolated Codex runtime and infrastructure recovery

The default server now supplies a trusted `isolatedRuntimeRoot` under `.cache/codex-runtime` to the Codex adapter. Bubblewrap mounts the host read-only, the assigned project workspace writable, and a fresh private runtime directory over the child's `~/.codex`. The existing `auth.json` is mounted read-only without copying credentials. User config and exec rules are ignored for this invocation. CLI runtime/session writes therefore stay inside the repository; the real home is unchanged. Temporary files use a private `/tmp`. The inner Codex `workspace-write` sandbox and approval policy remain enabled. Bubblewrap and permitted user namespaces are required; no unsandboxed fallback is provided. The CLI's model connection still requires operator-authorized network access. Credentials requiring refresh cannot be rewritten through this mount.

Execution stderr and process termination metadata now reach `FailureAnalyzer`. Recognized read-only filesystem, initialization, spawn and connection failures pause development with `needsAttention`, before a repair is reserved.

After a successful real provider smoke test, a trusted operator may call `AutonomousProjectService.retryInfrastructureFailure(runId)`, then `resume(runId)`. Recovery is not exposed through HTTP. It accepts only an idle failed run whose failed tasks have infrastructure evidence. Original execution runs remain in audit history; obsolete infrastructure repair tasks are archived, their budget reservations refunded, and development tasks reset to pending. A persisted project receipt permits retry after a checkpoint write failure without double refunds. Application failures cannot use this recovery path.
