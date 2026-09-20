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

The browser is a small vanilla JavaScript single-page interface using hash routes. It calls an Express JSON API. The API validates inputs, passes valid projects to the deterministic planner, and writes the resulting project document through a small JSON-file store.

`public UI → Express REST API → validation + planning engine → JSON data file`

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
| `PATCH` | `/api/projects/:id/tasks/:taskId` | Set `{ "completed": true/false }` |
| `DELETE` | `/api/projects/:id` | Delete a project |

`POST /api/projects` expects `name`, `description`, `platform`, `technology`, and `experienceLevel` strings. Example platforms: `Web`, `Mobile`, `Desktop`, `API / Backend`; technologies: `JavaScript`, `TypeScript`, `Python`, `Java`, `C#`, `Other`; experience levels: `Beginner`, `Intermediate`, `Advanced`.

## Project structure

- `src/app.js` — Express routes and error handling
- `src/server.js` — server startup
- `src/planner.js` — deterministic plan generator
- `src/store.js` — JSON persistence layer
- `src/validation.js` — request validation rules
- `public/` — responsive HTML, CSS, and browser JavaScript
- `data/` — runtime project data
- `test/api.test.js` — API integration tests

## Future improvements

- User accounts and authorization.
- SQLite or hosted database storage with safe concurrent writes.
- Editable/reorderable plan tasks and custom phases.
- AI-provider integration as an optional planning engine.
- Export plans to Markdown/PDF and project-management integrations.
