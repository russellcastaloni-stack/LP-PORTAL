# Security & data-integrity audit log

Consolidated from inline `audit N.N` / `CRIT-NN` references scattered across
`server.js`, `db.js`, `schema.sql`, and `app.js`. Each of these was a real
finding that got fixed in place, with the fix explained in a comment right
where it landed — this file exists so the full list can be read in one
sitting instead of grepping the codebase, not to replace those comments.

Numbering (`1.5`, `2.3`, etc.) reflects whatever informal audit pass first
flagged each issue — it's not sequential/complete on its own; several fixes
are dated `2026-07` instead of numbered because they came from ad-hoc reviews
rather than a formal numbered pass. All items below are already fixed
unless marked otherwise.

## Authentication & session handling

**CRIT-01 — `GET /api/profiles` exposed all profiles unauthenticated.**
Made private behind the global `/api` auth gate. `login.html` authenticates
via the separate public `/api/profiles/login` endpoint instead.

**Audit 2.1 — username spoofing on notes/widgets.** `requireOwnUsername`
(server.js) verifies the caller's JWT identity (`sub`/id or name) matches
the `:username` route param, so one user can't read or overwrite another
user's notes/widgets just by guessing their username.

**Audit 2.2 — chat sender spoofing.** Sender identity for `/api/chat/send`
is derived from the authenticated session server-side, not trusted from the
request body — prevents impersonating other users' display names in chat.

**Audit 2.3 — login rate-limiting was resettable.** Login attempts are
persisted in the `login_attempts` SQLite table (schema.sql), not just an
in-memory Map, so a deliberate or accidental server restart can no longer be
used to bypass the brute-force lockout window. An in-memory Map is still
kept as a fast pre-check cache to avoid hitting SQLite on every request when
an IP is well under the limit.

**Audit 2.6 — full session JWT exposed in file URLs.** Opening a Drive-
stored PDF used to put the long-lived session JWT directly in the URL
(browser history, access logs, Referer headers). Replaced with a
short-lived, single-file "view token" issued by `/api/view-file-token`
(15-minute expiry, scoped to one file) — the old `?token=`/`?sessionId=`
forms remain only as a legacy fallback during migration.

**Audit 3.7 — legacy admin token was a pure footgun.** The old
`ADMIN_TOKEN` (random hex, regenerated every restart) header fallback was
removed entirely. No frontend code referenced `X-Admin-Token` — every admin
client already authenticated via the signed JWT from `POST
/api/admin/login`.

## File access / path traversal

**Audit 1.5 — UNC-path / symlink-chain sandbox bypass.**
`resolveSandboxedFile()` (server.js) resolves the real, symlink-free path
(`fs.realpathSync.native`) before checking whether it falls inside
`DRIVE_FOLDER`/`JO_FOLDER`/`PROOFING_FOLDER`, instead of a naive
`startsWith()` on the raw string — closes a bypass where a crafted UNC path
or symlink chain could point outside the sandboxed folders while still
passing a string-prefix check. Applied at both `/api/open-file` and
`/api/view-file`.

**Audit 2026-07 — IDOR via reference-image paths.** A quote's reference
images are resolved against an explicit "owned paths" allow-list (paths
that actually belong to that quote's own images), not an arbitrary
DRIVE_FOLDER path from the request — otherwise a caller could reference any
other file under DRIVE_FOLDER and have it read and permanently embedded
into their own generated PDF.

## Rate limiting & abuse

**Security fix 1-3 (top-of-file list, server.js).** `POST
/api/admin/login`, `PATCH /api/profiles/:id/self`, and `PATCH
/api/profiles/:id/self-pin` are all now behind `checkRateLimit`.

**Security fix 5-6.** `POST /api/widgets/:username` capped at 256 KB body
size, `POST /api/notes/:username` capped at 512 KB — both are small
free-form scratch data, no legitimate use case needs more.

**Security fix 4.** `POST /api/open-file` sandboxed to
`DRIVE_FOLDER`/`JO_FOLDER` (see Audit 1.5 above for the mechanism).

**Security fix 7.** `renderPDF` (Puppeteer) has a hard 90-second overall
timeout, so a hung/stuck render can't tie up the shared browser instance
indefinitely.

## Data integrity (SQLite migration, 2026-07)

These came out of the JSON → SQLite migration and the full-system review
that followed it.

**Audit 2.3 (schema-side) / 4.4 — login_attempts + serials audit trail.**
`login_attempts` table backs the persistent rate limiter (see above).
`serials.updated_at` added so manual serial adjustments leave an audit
trail instead of being silent.

**Audit 3.2 — admin dashboard loading full file_data on every list view.**
`getAllJobOrders()`/`getAllProofing()` accept `includeFileData: false` to
skip `file_data` (base64 images, can be multi-MB per item) at the SQL level
for list views — the admin dashboard doesn't need embedded images just to
render a table.

**Audit 3.4 / 3.5 — year prefix hardcoding.** Job Order / Proofing document
numbers derive their 2-digit year prefix (`JO26-`, `PF26-`, etc.) from the
document's own date/creation time, not a hardcoded value — avoids
mislabeling documents created after a year boundary (e.g. a JO created in
January 2027 still tagged `JO26-`).

**Audit 7.2 — unbounded free-text fields.** `cap()` (db.js) enforces
server-side max lengths on free-form fields (material, address, etc.) —
the frontend has no `maxlength` on textareas, so without this a pasted huge
value would be stored permanently and re-sent on every
`getAllQuotes()`/`getAllJobOrders()` call.

**Audit 2026-07 — money columns stored as TEXT.**
`quote_items.{qty,unit_price,computed_unit_price,flat_price}` and
`quotes.discount_value` were TEXT, which blocked SQL-level SUM/aggregates
and allowed non-numeric garbage into price/qty fields. Migrated to REAL
columns (`_applySchemaPatches()` in db.js handles this on existing
databases; `num()`/`numOrNull()` guarantee every write from here on is a
real number, stripping thousands-separator commas first).

**Audit 2026-07 — profile email case-sensitivity.** The plain `UNIQUE` on
`profiles.email` was case-sensitive, but every lookup
(`getProfileByEmail`) matches on `LOWER(email)` — `"A@x.com"` and
`"a@x.com"` could previously both be inserted as separate rows, silently
defeating the uniqueness the app relies on. Fixed with
`idx_profiles_email_lower`, a case-insensitive unique index (schema.sql).
If case-variant duplicates already exist on an old database, the patch
step logs and skips instead of crashing startup — those need a manual
merge first.

**Audit 2026-07 — company-key mismatch (the "Loob Philippines" saga).**
`normalizeCompanyKey()` must stay byte-for-byte identical across
`db.js`, `server.js`, and `app.js` (`companyKey()`) — this single function
caused weeks of duplicate client/serial records when a business-name
variant ("Loob Philippines" vs "Loob Philippines Inc.") normalized
differently in two places. See the smoke test in `db.test.js` that
pins this behavior down.

**Audit 2026-07 — Additional Fees / grouped-item data loss.** Several
related bugs where `saveQuote()` read a field the client never actually
populated (silently writing 0/empty on every save-reload cycle): outsource
items' `basePrice`/`multipliers` had no column to land in at all; flat-rate
("Additional Fees") items had their real price read from the wrong field;
grouped quote items lost their `_type` tag (in-house/fixed/flat) and,
separately, their formula-builder state. All fixed via new columns
(`base_price`, `group_item_type`) and by reading/writing the fields the
client actually sends.

## Known gap (not yet acted on)

Several of the fixes above (Audit 1.5, 2.6, IDOR fix) rely on `DRIVE_FOLDER`
staying a trustworthy, available filesystem path. `launchpad.db` itself was
moved off that Google Drive-synced folder in 2026-07 for reliability
reasons (see `DATABASE-MIGRATION.md`) — PDFs and JSON scratch files
(`lp_widgets.json`, `lp_notes.json`, `lp_chat.json`,
`lp_announcement.json`) still live there and were out of scope for that
move.
