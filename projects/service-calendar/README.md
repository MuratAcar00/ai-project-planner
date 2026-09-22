# Service Calendar

Service Calendar helps local workshop owners register equipment, plan maintenance intervals, and record completed service before missed maintenance stops a machine. It is a zero-dependency Node.js CommonJS application (Node.js 18 or newer) using built-in HTTP and plain HTML/CSS/JavaScript.

## Setup and verification

From this repository directory, with Node.js and npm available:

```sh
node --version
npm test
npm run build
npm start
```

No installation step is needed. There are no package dependencies, install scripts, accounts, API keys, external APIs, or network integrations. Open `http://localhost:3000` in a modern browser; stop the server with Ctrl+C. If port 3000 is occupied, use `PORT=3001 npm start` in a POSIX shell and open `http://localhost:3001`. The application binds to `127.0.0.1`.

## Workshop workflow

Open `http://localhost:3000` after starting the server to use the responsive workshop dashboard. Register equipment with its first due date and interval, search by name or location, filter by service status, and use **Edit** to update equipment and scheduling. **Service log** shows history and records completed maintenance; **Export summary** downloads the API's concise plain-text summary. The dashboard starts empty and uses only saved equipment, with no sample records or external assets.

The browser UI uses plain HTML, CSS and JavaScript in `public/`, native accessible dialogs, bounded form fields, safe text rendering, and retryable error states. Use a modern browser with native dialog, Fetch and AbortSignal.timeout support. Dates follow the API's UTC calendar convention. The server serves only three allowlisted public assets and restricts scripts, styles and requests to the same origin.

- `npm start`: listen on localhost:3000 (optional `PORT` environment variable).
- `npm test`: run tests using isolated workspace-local temporary storage.
- `npm run build`: check server entry-point syntax.

`createServer({ dataFile })` from `src/app.js` returns an unlistened HTTP server. The default data file is `data/service-calendar.json`; the directory is created on the first successful mutation. An optional `store` implementing `read()` and `update(callback)` can also be injected.

## Architecture

| File | Responsibility |
| --- | --- |
| `src/server.js` | Validate `PORT` and start the loopback listener |
| `src/app.js` | Export `createServer()`, route HTTP requests, enforce body limits, serve allowlisted assets and generate exports |
| `src/domain.js` | Validate records, generate IDs and compute UTC schedules |
| `src/store.js` | Validate the versioned JSON store and serialize atomic writes |
| `public/index.html`, `public/styles.css`, `public/app.js` | Responsive dashboard, forms, service log and downloads |
| `test/*.test.js` | Domain, persistence, request-listener and real HTTP tests |

The request flow is browser → HTTP route → domain validation → local JSON storage. There is no build output or database service. `npm run build` only checks entry-point syntax.

For isolated embedding or tests, supply a file inside a temporary directory in this workspace:

```js
const { createServer } = require('./src/app');
const server = createServer({ dataFile: './test/manual-data/calendar.json' });
// No port is opened until the caller invokes listen().
server.listen(3001, '127.0.0.1');
```

## API

JSON request bodies require `Content-Type: application/json` and are limited to 16 KiB. Errors return `{ "error": "message" }`. Lists return arrays; individual operations return records. POST returns 201 with a Location header; DELETE returns 204.

| Route | Methods | Purpose |
| --- | --- | --- |
| `/api/health` | GET | `{ "status": "ok" }` |
| `/api/equipment` | GET, POST | List or register equipment |
| `/api/equipment/:id` | GET, PATCH, DELETE | Read, edit or delete equipment |
| `/api/equipment/:id/services` | GET, POST | List or record maintenance |
| `/api/equipment/:id/services/:serviceId` | GET, PATCH, DELETE | Read, correct or remove service history |
| `/api/export` | GET | Download a concise plain-text workflow and equipment summary |

Equipment requires `name`, `intervalDays` (integer 1–3650), and `nextServiceDate` (initial due date, YYYY-MM-DD). Optional `location` and `notes` default to empty strings. Service records require `date` and `description`; `technician` is optional. Dates must be real calendar dates between years 1900 and 9989. The upper bound leaves room for the maximum interval while keeping calculated due dates within year 9999. Text limits are 200 characters except notes and descriptions (2000). Unknown fields are rejected; PATCH requires at least one valid field.

Equipment responses include `lastServiceDate`, `dueDate`, and `status` (`overdue`, `due`, `scheduled`), calculated using UTC dates. Once history exists, the latest service date plus the current interval determines the due date. Editing or deleting history recalculates the schedule; removing all history restores the initial due date. Deleting equipment also deletes its history.

Writes are serialized within the process and persisted using atomic file replacement. Run a single application process per data file. Corrupt storage is preserved and yields a generic 500 response. This backend has no accounts or external integrations and binds to loopback by default. Text is returned as JSON or a plain-text download; clients should display user content using `textContent`, never `innerHTML`.

Example requests (with the server running; these create local records):

```sh
curl http://localhost:3000/api/health
curl -i http://localhost:3000/api/equipment \
  -H 'Content-Type: application/json' \
  -d '{"name":"Workshop lathe","location":"Main workshop","intervalDays":30,"nextServiceDate":"2026-10-01"}'
```

Use the equipment ID from the response in place of `EQUIPMENT_ID`:

```sh
curl http://localhost:3000/api/equipment/EQUIPMENT_ID/services \
  -H 'Content-Type: application/json' \
  -d '{"date":"2026-10-01","description":"Changed oil and inspected belts","technician":"Workshop owner"}'
curl http://localhost:3000/api/equipment/EQUIPMENT_ID
curl http://localhost:3000/api/export
```

The resulting equipment due date is `2026-10-31`. PATCH accepts a subset of the same input fields; generated IDs, creation timestamps and calculated fields are read-only. Service responses include `id`, `equipmentId`, `createdAt`, `date`, `description`, and `technician`. Validation failures return 400, missing routes/records 404, unsupported equipment-route methods 405, oversized bodies 413, unsupported content types 415, and storage failures 500.

## Privacy and local data

Equipment names, locations, notes, technician names and service descriptions are stored in plaintext on this machine in `data/service-calendar.json`. The app sends no telemetry, uses no third-party assets, and does not send records to external services. It uses neither cookies nor browser local storage for persistence. Exported summaries contain equipment names and the latest service description; treat downloaded files as workshop data too.

There is no authentication, encryption at rest, or per-user separation. Anyone with access to this local server can read and change its records; operating-system access also governs the data file and downloads. New storage files use owner-only permissions on systems that support them. Keep runtime data and exports out of version control.

For backup, stop the server and copy the JSON file to a protected location. Restore a backup to the same path while the server is stopped, then restart. There is no automated backup or import interface. Deleting equipment through the API removes its associated service history; backups and downloaded exports are separate copies. If storage is corrupt, preserve it and restore a known-good backup: the app will not silently reset it. The health endpoint confirms the HTTP handler is alive, not that storage is readable or writable.

## Limitations

- Designed for a small workshop on one machine, with one process per data file. Entire datasets are read and rewritten in memory; there is no pagination, database indexing, or multi-process locking.
- Intervals are fixed numbers of days, not calendar months or machine usage hours. UTC determines “today”; local dates may differ near midnight. Future service dates are accepted, so record completed work carefully.
- No background reminders, email, calendar synchronization, automatic service completion, or external integrations. Use Refresh to update the dashboard after another client changes data or the UTC date changes.
- The dashboard supports registration, equipment editing, service recording/history, search, filtering and export. Equipment deletion and correcting/deleting history are API-only operations.
- The export is a concise text summary with the latest service per machine, not a complete history export or restorable backup.
- No duplicate detection or idempotency keys. If a write times out, refresh the equipment/history before retrying to avoid duplicate records.

## Test coverage

Tests cover domain scheduling and validation boundaries, equipment and service API workflows, scoped history access, exports, corrupt storage, concurrent writes, and recovery after failed mutations. Storage validates mutations before replacing saved data. Every storage fixture uses a unique temporary directory under `test/` and removes it afterward; tests never use the default application data file.

`test/http.test.js` additionally sends real HTTP requests to an ephemeral loopback port. These tests explicitly skip only when the environment denies listening (`EPERM` or `EACCES`); the request-listener API tests still run without sockets.


## Acceptance review

The MVP implementation covers all four requested features:

| Feature | Acceptance check |
| --- | --- |
| Register equipment | Save a name, interval and initial due date; the equipment appears after refresh and restart |
| Schedule maintenance | Edit an interval; after service, the latest service date plus that interval sets the next due date |
| Record service history | Add completed work in Service log; history and the dashboard schedule update |
| Export workflow summary | Export summary downloads local plain text containing the workflow and equipment schedules |

Automated tests exercise the API workflow, persistence across server instances, invalid requests and date boundaries, including the maximum supported date plus interval. Static review confirms local assets and text-based rendering. For a browser acceptance pass, perform the four checks above, search/filter the equipment, and verify narrow-screen layout and keyboard dialog navigation. The automated suite does not drive a browser, so visual and interactive browser checks remain manual verification steps; they are not reported as automated coverage.
