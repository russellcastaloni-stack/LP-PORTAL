# Database location & migration notes

## Where the database lives

`launchpad.db` (all clients, quotes, serials, job orders, proofing records,
and profiles) lives on **local disk**, at:

```
data/launchpad.db
```

(next to `server.js`, inside the project folder — not on the `G:\` Google
Drive-synced shared drive).

Generated PDFs (quotations, job orders, proofing sheets) and a few small
JSON files (announcements, widgets, notes, chat) still live on the Drive
shared folder as before — only the SQLite database itself was moved.

## Why it's not on Google Drive

Before 2026-07, `launchpad.db` lived inside `DRIVE_FOLDER`
(`G:\Shared drives\JOBS (OPERATIONS)\8_SALES\1. Launchpad Portal\1. Quotations`),
the same Google Drive-synced folder the PDFs are saved to.

SQLite runs in WAL mode here (`journal_mode = WAL`), which depends on real
OS-level file locking to coordinate reads/writes safely. Google Drive for
Desktop's virtual filesystem doesn't implement that locking correctly —
it's the same known-bad combination as running SQLite over Dropbox, OneDrive,
or NFS. In practice this surfaced as intermittent `SQLITE_PROTOCOL`
("locking protocol") errors in the server logs, and carried a real risk of
**silent database corruption** if Drive ever synced the `.db` file mid-write,
or synced it out of step with its `-wal`/`-shm` companion files.

Moving the live database to local disk removes that risk entirely. Drive
sync only ever touches the periodic *backup* snapshots now (see below),
which are always internally consistent, never a live/open file.

## Automatic backups

Every 15 minutes (and once on startup), the server writes a consistent
snapshot of the live database to:

```
G:\Shared drives\JOBS (OPERATIONS)\8_SALES\1. Launchpad Portal\1. Quotations\db-backups\
```

Snapshots use `VACUUM INTO`, which is safe to run against a live, open
database — it can't grab a half-written page the way a plain file copy
could.

Filenames are keyed by time-of-day slot, e.g. `launchpad_0000.db`,
`launchpad_0015.db`, ... `launchpad_2345.db` — 96 fixed names, one per
15-minute slot of the day. Each one gets overwritten again ~24 hours later,
so you always have a full rolling day of history at 15-minute granularity,
and the `db-backups` folder never grows past 96 files.

## Moving this app to a new PC

If the server is ever moved to a different machine (new PC, reinstall,
disaster recovery), the local `data/launchpad.db` file does **not** travel
with a plain code copy/git pull — it's excluded from git on purpose (see
`.gitignore`) since it's live business data, not code.

Before starting the server on the new machine:

1. Go to the `db-backups` folder on the Google Drive shared drive (path
   above).
2. Find the most recent snapshot. Sort by "Last modified" — don't assume
   the highest-numbered filename (`launchpad_2345.db`) is the newest one;
   the numbering is a time-of-day slot, not a sequence.
3. Copy that file into the new machine's project folder as:
   ```
   data/launchpad.db
   ```
   (create the `data` folder if it doesn't exist yet).
4. Only then start the server (`start.bat` / `pm2 start server.js`).

If you skip step 3 and start the server on a machine with no `data/launchpad.db`
present, it will create a **brand-new, empty** database — none of your quotes,
clients, or serials will be there. If that happens, stop the server
immediately, delete the empty `data/launchpad.db` (and any `-wal`/`-shm`
files next to it), then follow steps 1-4 above.

## One-time migration (2026-07)

The very first time the server started after this change, it automatically
detected the old database at the Drive location, copied it (plus its
`-wal`/`-shm` sidecars, so no very-recent write was lost) into
`data/launchpad.db`, and logged:

```
[db] One-time migration: copied launchpad.db from Google Drive to local disk (...)
```

The old copy on Google Drive was **not deleted** — it's just an inert,
increasingly stale file now. It's safe to leave it there, or manually
archive/delete it once you've confirmed the local database has been working
correctly for a few days.
