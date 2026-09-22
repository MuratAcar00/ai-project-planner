# Decision Log

Remember why your team made a decision. Decision Log helps small product teams preserve decisions, context, alternatives, tags and review dates between meetings. This MVP runs locally using zero-dependency Node.js CommonJS and plain HTML/CSS/JavaScript.

## Setup

Use Node.js 22 or later with npm and a modern browser supporting native HTML dialogs and Fetch. From the project directory, run:

```sh
node --version
npm start
```

Open `http://127.0.0.1:3000`. No installation, account, environment file, API key or build step is required. Stop the server with Ctrl+C. Port 3000 must be available; the server binds only to IPv4 loopback. If `localhost` resolves to IPv6 on your machine, use the explicit IPv4 address above.

- `npm start`: listen at `http://localhost:3000` (loopback only).
- `npm test`: run validation, domain, persistence, HTTP handler and loopback HTTP tests.
- `npm run build`: check the server entry point syntax.

`createServer({ dataFile })` exported by `src/app.js` returns an unlistened HTTP server. The optional file path enables isolated storage. The default is workspace-local `data/decisions.json`; it is created on the first successful write. Run one server/store instance per data file. Writes within that instance are serialized and use atomic replacement. Corrupted files cause an error and are not overwritten.

## Architecture

| File | Responsibility |
| --- | --- |
| `src/server.js` | Starts the HTTP server on port 3000 |
| `src/app.js` | Exports `createServer(options)`; routes requests, serves allowlisted assets, limits JSON bodies and maps errors |
| `src/validation.js` | Validates editable fields, array limits and calendar dates |
| `src/store.js` | Persists JSON, validates stored records and queues atomic file replacements |
| `public/index.html`, `public/styles.css`, `public/app.js` | Dashboard, responsive styling, editor, local filtering and export download |
| `test/*.test.js` | Built-in Node tests for validation, storage, HTTP and asset serving |

The browser loads records from the API into memory. Saves go through validation before storage, and export reads saved records. Tests inject `dataFile` paths under temporary workspace directories; handler tests can also inject a `store` object. There are no third-party runtime or test packages.

## API

All request and response bodies use JSON. Create and update requests require `Content-Type: application/json`; bodies are limited to 128 KiB. No accounts or external services are used.

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/api/health` | `{ "status": "ok" }` |
| GET | `/api/decisions` | Array of decisions |
| POST | `/api/decisions` | Create; returns 201 with decision and Location |
| GET | `/api/decisions/:id` | Read one |
| PATCH | `/api/decisions/:id` | Update supplied fields |
| PUT | `/api/decisions/:id` | Replace editable fields; omitted optional fields reset |
| DELETE | `/api/decisions/:id` | Delete; returns 204 |
| GET | `/api/decisions/export` | Download a JSON array |

List and export accept combined filters: `q` (case-insensitive text search across title, context, decision, alternatives and tags), `tag` (case-insensitive exact tag), and `reviewBefore` (inclusive YYYY-MM-DD date; excludes undated decisions). Query values are limited to 200 characters; duplicate and unknown parameters are rejected.

Decision fields:

- `title`: required nonblank string, up to 200 characters.
- `decision`: required nonblank string, up to 10,000 characters.
- `context`: optional string, up to 10,000 characters; defaults to empty.
- `alternatives`: up to 30 nonblank strings, each up to 2,000 characters; defaults to `[]`.
- `tags`: up to 20 nonblank strings, each up to 50 characters; defaults to `[]`.
- `reviewDate`: valid YYYY-MM-DD date or `null`; defaults to `null`.

Strings are trimmed and duplicate array values removed. IDs and creation/update timestamps are server-managed. Unknown fields are rejected. Errors use `{ "error": "message" }` with 400 for validation, 404 for missing records/routes, 405 for unsupported methods on decision routes, 413 for oversized bodies, 415 for unsupported body media types, and 500 for storage failures. Internal storage details are not exposed.

With the server running, these optional curl examples check health, save an example decision, search it, and print an export. The POST creates a persistent record in the local library.

```sh
curl http://127.0.0.1:3000/api/health
curl -i http://127.0.0.1:3000/api/decisions \
  -H 'Content-Type: application/json' \
  --data '{"title":"Keep decisions locally","decision":"Use a JSON file","context":"Small team MVP","alternatives":["Hosted database"],"tags":["architecture"],"reviewDate":"2026-10-01"}'
curl 'http://127.0.0.1:3000/api/decisions?q=locally&tag=architecture'
curl http://127.0.0.1:3000/api/decisions/export
```

Use the returned `id` in `/api/decisions/:id` for subsequent reads and edits. PATCH accepts a nonempty subset of editable fields; PUT requires `title` and `decision`. Responses include `id`, all six editable fields, and ISO UTC `createdAt` and `updatedAt` timestamps. The total URL limit is 2,048 characters; the 128 KiB body limit applies in addition to individual field limits.

## Browser dashboard

Open `http://localhost:3000` after `npm start`. The responsive dashboard uses local HTML, CSS and JavaScript with no dependencies or external services. Create or edit decisions, capture context and alternatives, add comma-separated tags, and set or clear review dates. Search covers all decision text; combine it with tag and review filters. Review counts use the browser’s local calendar date. Export JSON downloads every saved decision, regardless of active filters.

The initial library is empty; no sample records are inserted. Loading and failure states include retry, and failed saves preserve the editor contents. Native dialog focus handling, labeled fields, keyboard focus indicators, live status messages and mobile layouts support accessible use. Stored content is rendered with `textContent`. Only three explicitly allowed public assets are served, with a restrictive content security policy and `nosniff` headers.

Manual browser check: create a decision with tags, alternatives and a review date; reload to confirm persistence; edit and clear its date; search its context and filter by tag; check due/upcoming filters; export and inspect the JSON. Repeat at a narrow viewport and with keyboard-only navigation.

## Tests and acceptance review

Run from the project directory:

```sh
npm test
npm run build
```

The build command only checks entry-point syntax; it does not generate a bundle. Tests create and remove temporary storage inside the workspace and never use production data. API scenarios run against the unlistened request handler and real HTTP on an ephemeral loopback port. Real HTTP cases explicitly skip when the environment denies socket permissions (EPERM/EACCES); handler coverage still runs. Persistence tests cover corrupted records, failed atomic replacement, cleanup and queue recovery.

| MVP requirement | Implementation and verification |
| --- | --- |
| Create and edit decisions | Browser editor and POST/PUT/PATCH API; lifecycle, validation and persistence tests |
| Tag and search decisions | Browser search/tag controls and combined API filters; search and filter tests |
| Track review dates | Optional date, due/upcoming counts and date filters; calendar validation and API cutoff tests |
| Export JSON | Browser download of all saved decisions and filterable export API; export compared with persisted state |
| Local, dependency-free operation | Built-in HTTP, workspace JSON storage and allowlisted local assets; asset and storage tests |

Automated tests cover the backend and asset delivery, not browser interactions or visual accessibility. Use the manual browser check above to verify dialogs, downloads, keyboard navigation and responsive layout. The implemented MVP has no placeholder features; the limitations below describe its intended scope.

## Privacy and data handling

Decision content stays in the local server's JSON file and in browser memory while the page is open. There are no external APIs, analytics, remote fonts, accounts or network integrations. The browser communicates with the local server; exporting creates another plaintext copy in your downloads location.

Storage is not encrypted. New storage files use owner-only permissions (`0600`, subject to platform behavior), but users or processes with filesystem access can read them. There is no authentication or authorization: any client able to reach the server can read, change, export or delete decisions through the API. Keep this local MVP bound to loopback. Safe text rendering and restrictive asset security headers do not provide user access control.

For backups, stop the server and copy `data/decisions.json` to a protected location. To restore, stop the server and replace that file with a known-good copy of the same schema, then restart. Preserve a corrupted file for recovery before replacing it. API deletion removes a record from current storage, but does not erase previous exports or backups. Do not include working data or exports in source control.

## Limitations

- A single local instance is intended for a small decision library. There is no shared hosting, multi-user permission model, live synchronization or conflict detection; the last accepted edit wins.
- Each operation reads the whole JSON file, and each mutation rewrites it. There is no pagination, database indexing, multi-process file locking or crash-durability guarantee from disk synchronization.
- Review dates are calendar dates with browser-local due counts. There are no reminders, notifications, recurring reviews or automatic completion; edit or clear a date after review. Reload to refresh data and counts in a long-open tab.
- There is no revision history, import screen or undo. Delete is available through the API only. JSON export includes all fields and has no redaction.
- The browser editor uses commas to separate tags and newlines to separate alternatives. API clients should avoid embedded separators in those values if they will later be edited in the dashboard.
- The health endpoint reports server responsiveness, not storage integrity. Storage failures return a generic error; check local file permissions and JSON validity when troubleshooting.
