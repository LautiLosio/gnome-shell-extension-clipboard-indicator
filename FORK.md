# Large-history Clipboard Indicator

This fork preserves Clipboard Indicator's GNOME workflow while replacing the
architecture that couples every stored entry to a live Shell menu row.

Status: first experimental implementation. SQLite, bounded result windows, local
semantic search, OCR, and separate tray/history menus are implemented. See README
for supported behavior, validation, and remaining limitations.
Upstream baseline: c880c7fb88dc7232a61a5864d125989a4f375daa.

## Goals

- Keep years of text, links, and images with predictable UI memory and opening time.
- Keep archive queries, serialization, image processing, and model inference outside GNOME Shell.
- Search the entire archive while displaying a bounded result window.
- Add local semantic retrieval alongside exact and indexed keyword search.
- Preserve pinning, tags, editing, private mode, excluded apps, keyboard navigation, and paste behavior.
- Import existing history without destroying or overwriting the original cache.

## Architecture direction

The extension owns clipboard integration and a bounded menu. A separate local
service owns a SQLite archive, full-text index, attachment files, thumbnails,
and background indexing. Communicate asynchronously over private JSON-line subprocess pipes. The helper
is owned by the extension; a session D-Bus API remains an option if independent
clients are added. Query responses contain IDs, short summaries, and thumbnail references;
full payloads are fetched only when needed. Use stable IDs and cursor pagination.

Start with recent entries and keyword search. Add embeddings and OCR behind a
background queue. Combine semantic and lexical ranking, preserving exact-match
retrieval for URLs, commands, and identifiers. Model choice and vector-index
implementation remain open pending measured resource use and packaging checks.
Clipboard content stays local by default; no hosted inference or telemetry.

UI work must remain bounded even for pinned items and broad search results.
Cancel or ignore outdated queries; debounce input; avoid constructing offscreen
image previews. Separate persistent records from view widgets throughout.

## Milestones

1. Reproducible baseline: synthetic 1k, 10k, and 100k histories with text, large
   text, images, pins, and tags. Measure cold/warm opening, typing latency,
   Shell frame stalls, RSS, and copy-to-persistence latency.
2. Bounded menu and separate data model: retain access to all entries through
   lazy scrolling/search, load only visible thumbnails, preserve existing actions.
3. Archive service: incremental SQLite writes, indexed keyword queries,
   attachment deduplication, crash recovery, and service lifecycle management.
4. Migration: idempotent import, backups, validation of imported counts and
   attachment integrity, independent development UUID/data directory, rollback.
5. Semantic retrieval: local embeddings, background OCR, mixed ranking,
   reindexing after edits, deletion of derived data, and offline operation.
6. Packaging and live GNOME validation before replacing the installed extension.

## Acceptance criteria

Targets to validate on documented reference hardware, not current guarantees:

- Warm opening p95 below 100 ms; no extension-attributable Shell stall above 50 ms.
- Keyword result latency p95 below 100 ms at 100k entries; report semantic latency separately.
- Live row count remains bounded as archive size grows, including pinned results.
- A background indexing backlog never blocks capture or lexical search.
- Migration and restart retain payloads, tags, and pins without duplicates.
- Searches cannot expose deleted entries through stale indexes or thumbnails.
- Disk accounting includes originals, thumbnails, database, indexes, and journals.

Keep retention optional and explicit. Never silently reset the archive on a size
threshold. Unlimited retention is constrained by available disk space; quotas
must have documented behavior and protect pinned entries according to policy.

## Investigation limits

The installed version exhibits eager menu rows and image previews, linear
per-keystroke filtering, eager startup payload loading, and whole-history JSON
writes. These are scaling risks, not a measured allocation of the reported pause.
Profile the upstream checkout before assuming every installed-version detail is
identical. Do not benchmark with or commit personal clipboard data.
