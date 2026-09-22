# Document Watch

Document Watch helps small office administrators find upcoming business document renewals before they are missed. Register metadata, assign an owner and expiry date, filter renewals, and download a concise workflow summary. Original documents stay wherever you already keep them; there are no uploads.

## Setup and use

Requires Node.js 18 or newer, npm to run the scripts, and a modern browser with native dialog support. There are no dependencies to install, build artifacts to generate, accounts to create, or secrets to configure.

From the project directory:

```sh
npm start
```

Open <http://127.0.0.1:3000>. Stop the server with Ctrl+C. If port 3000 is occupied, use `PORT=3001 npm start` in a POSIX shell and open port 3001 instead. The server listens on loopback only.

1. Select **Register document** and enter a title, owner, and expiry date. Category and notes are optional.
2. Select **Review** to view or edit metadata. After renewing a document, update its expiry date. Deletion requires confirmation.
3. Choose an expiry window and/or owner, then select **Apply filters**. Use **Reset** to see the whole register.
4. Select **Export summary** to download `document-watch-summary.txt` for the applied filters. Each line includes the expiry date, title, owner, and a renewal action. Export is disabled when no documents are shown.

Overview counts always reflect the full register. The list and export reflect applied filters, sorted by expiry. Dates use UTC; upcoming windows include today and exclude expired documents. Custom date ranges include both endpoints. The page refreshes data after mutations or filter application; reload it to refresh an idle view.

Storage is created automatically at `data/documents.json` on the first successful mutation. Restarting the server preserves registered metadata.

## Verification and acceptance review

```sh
npm test
npm run build
```

`npm test` runs Node's built-in test runner. `npm run build` checks the server entry point's syntax; there is no compilation step. Tests use temporary directories under `test/`, remove them afterward, and never open the default data file.

The automated acceptance coverage is:

| MVP requirement | Verification |
| --- | --- |
| Register metadata without uploads | Creation, field limits, required fields, invalid inputs, and unknown-field rejection |
| Track owners and expiry dates | Persistent CRUD, replacement and partial updates, date validation, and restart reads |
| Filter upcoming renewals | Inclusive boundaries, leap day, today-only windows, owner matching, sorting, and invalid filters |
| Export a concise workflow summary | Filtered plain-text export, owner/date content, and safe handling of markup and line breaks |
| Run locally without dependencies | Required scripts, unlistened server factory, health response, and local allowlisted assets |
| Preserve storage on failure | Concurrent mutations, failed-mutation queue recovery, corrupt-file preservation, and generic API errors |

Acceptance review found all four requested workflows implemented with no unfinished MVP features. Both test files and the build check pass. Running the test files individually confirmed 11 passing cases and one skipped real HTTP case: this review environment denies loopback sockets with `EPERM`. The HTTP test skips only for `EPERM`/`EACCES`; request-handler tests still exercise the API and static assets. No interactive browser session was performed.

For a browser smoke check on a machine that permits loopback sockets: register a record due today, confirm it appears in **Next 30 days** for its owner, download its summary, change its expiry outside that window, reset filters, reload to check persistence, and delete it. Also verify an empty result, required-field feedback, and keyboard operation of the editor.

## Architecture

The application uses zero-dependency Node.js CommonJS and plain HTML/CSS/JavaScript.

| File | Responsibility |
| --- | --- |
| `src/server.js` | Validate `PORT` and listen on `127.0.0.1` |
| `src/app.js` | Built-in `http` server, API routing, bounded JSON parsing, static assets, and export |
| `src/domain.js` | Metadata validation, UTC expiry windows, owner filtering, and sorting |
| `src/store.js` | JSON persistence, serialized mutations, and atomic file replacement |
| `public/index.html`, `public/styles.css`, `public/app.js` | Responsive dashboard, metadata editor, filters, and download |
| `test/backend.test.js`, `test/critical.test.js` | Domain, storage, request-handler, asset, and HTTP integration tests |

`createServer({ dataFile })` exported from `src/app.js` returns an **unlistened** HTTP server. Callers can inject an absolute workspace-local file path for isolated storage and choose when to listen. Without options it uses `data/documents.json`. Merely importing the module does not start a server.

Mutations are serialized within one store instance and written through a temporary file followed by rename. Missing storage starts an empty register. Invalid storage causes an error and is not overwritten. Use only one server/store writer per data file.

## API

Requests with a body require `Content-Type: application/json`. Success responses are JSON unless noted below.

| Method | Route | Result |
| --- | --- | --- |
| GET | `/api/health` | 200, `{ "status": "ok" }` |
| GET | `/api/documents` | 200, `{ "documents": [...] }`, sorted by expiry |
| POST | `/api/documents` | 201, `{ "document": {...} }`, with a `Location` header |
| GET | `/api/documents/:id` | 200, `{ "document": {...} }` |
| PATCH | `/api/documents/:id` | 200, update supplied metadata fields |
| PUT | `/api/documents/:id` | 200, replace metadata; omitted optional fields become empty |
| DELETE | `/api/documents/:id` | 204, no response body |
| GET | `/api/export` | 200, plain-text attachment with the filtered renewal workflow |

POST and PUT require `title` (1–200 characters), `owner` (1–120), and `expiryDate` (valid `YYYY-MM-DD`). Optional `category` (up to 100) and `notes` (up to 2000) default to empty strings. PATCH requires at least one supported field. Fields must be strings, are trimmed, and have their length checked before trimming. Unknown fields and prohibited control characters are rejected. IDs and `createdAt`/`updatedAt` timestamps are generated by the server. JSON request bodies are limited to 16 KiB and URLs to 2048 characters.

For example, with the server running, this optional curl command creates a record in the local register:

```sh
curl -i http://127.0.0.1:3000/api/documents \
  -H 'Content-Type: application/json' \
  -d '{"title":"Office insurance","owner":"Alex","expiryDate":"2027-01-31","category":"Insurance","notes":"Contact insurer before renewal"}'
```

List and export accept the same query parameters:

| Parameter | Meaning |
| --- | --- |
| `owner=Alex` | Case-insensitive exact match; surrounding whitespace is trimmed |
| `from=2027-01-01` | Inclusive lower expiry date |
| `to=2027-01-31` | Inclusive upper expiry date |
| `withinDays=30` | Today through 30 days ahead, inclusive, in UTC |

`withinDays` accepts integers from 0–3650 and cannot combine with `from` or `to`. Owner can combine with either date mode. Unknown or repeated parameters, empty filters, invalid dates, and reversed ranges are rejected. Expired documents remain visible without date filters; use `to` for older expiries. URL-encode parameter values.

```sh
curl 'http://127.0.0.1:3000/api/documents?owner=Alex&from=2027-01-01&to=2027-01-31'
curl 'http://127.0.0.1:3000/api/export?withinDays=30'
```

Errors return `{ "error": "..." }`: 400 for invalid input, 404 for missing resources, 405 for unsupported API methods (with `Allow`), 413 for oversized bodies, 414 for oversized URLs, 415 for non-JSON request bodies, and 500 for internal/storage failures. Health reports that the server responds; it does not validate storage availability.

## Privacy and limitations

Metadata stays in the workspace-local JSON file. Browser requests go to this local server only. There are no external APIs, network integrations, telemetry, external fonts, accounts, or file uploads. Assets are local, metadata is rendered through `textContent` or form values, and exports use plain text. Responses disable caching and MIME sniffing; static assets include a same-origin Content Security Policy.

The JSON file and downloaded summaries contain readable metadata, including owner names. Storage is not encrypted, and the application has no authentication or access controls for users who can reach the server. Keep it on loopback on a trusted machine and avoid putting credentials or sensitive document contents in notes. Newly written data files request owner-only permissions where the operating system supports them.

This is a small local register, with these deliberate limits:

- No reminders, email, background monitoring, automatic renewal, or expiry discovery from original files. Administrators must review the register regularly.
- No multi-user coordination, audit history, undo, import, pagination, or full-text search. Owner names are free text rather than accounts.
- JSON storage reads the whole register and rewrites it on mutation; it is intended for small datasets, with one writer per file and no cross-process locking.
- No automated backups or crash-durability guarantee beyond atomic replacement. Stop the server before copying the data file for backup or restoring a known-good copy. A corrupt file must be repaired/restored before document operations can resume.
- Exports omit category and notes and are workflow summaries, not full backups. Deleting a record does not remove previously downloaded copies or backups.
- No browser automation is included. The responsive layout and editor need the manual smoke check above in target browsers.
