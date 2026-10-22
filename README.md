# Clipboard Indicator Fork

An experimental fork of [Clipboard Indicator](https://github.com/Tudmotu/gnome-shell-extension-clipboard-indicator),
created by **Yotam Bar-On (Tudmotu)** and developed by its maintainers and
[contributors](https://github.com/Tudmotu/gnome-shell-extension-clipboard-indicator/graphs/contributors).
The original project provides the foundation for this fork, including its GNOME
integration, clipboard workflow, settings, translations, and supporting code.
Full credit for that work belongs to the original authors and contributors.

This fork focuses on large local archives and a separate floating history popup.
It is independently maintained and is **not an official release or an endorsed
version of the upstream project**. The original MIT license and copyright notice
are retained unchanged in [LICENSE.rst](LICENSE.rst).

## AI development disclosure

**This fork's architecture changes, implementation, tests, and documentation were
created with AI using OpenAI Codex, directed by the fork owner.** This disclosure
applies to the changes in this fork, not to the original project's development.
Passing automated checks does not establish production readiness or a complete
human review. Treat this build as experimental and report reproducible failures.

## What changes compared with the original

The comparison below describes the upstream code this fork started from,
[commit c880c7f](https://github.com/Tudmotu/gnome-shell-extension-clipboard-indicator/tree/c880c7fb88dc7232a61a5864d125989a4f375daa).
Upstream may change independently. These are architecture and workflow changes;
performance claims are limited to the measurements described below.

| Area | Original at the fork baseline | This fork |
| --- | --- | --- |
| Persistent history | JSON registry with whole-history serialization on saves; separate cached image files | SQLite database with incremental record writes and attachment files |
| Work inside GNOME Shell | History comparison, serialization, and menu work run in Shell | Hashing, database operations, OCR, embeddings, and semantic retrieval run in a private helper process |
| Menu size | A live row is created for every retained entry | One continuous, lazy-loaded list with at most 60 live result rows, including pinned entries |
| Image loading | Startup loads cached image payloads; menu rows create image previews | Originals stay on disk until requested; background workers create 96-pixel thumbnails for result rows |
| Duplicate detection | Walks the retained history and compares entry values | SHA-256 of the incoming item, looked up through a unique database index |
| Search | Substring and optional regex matching against entries and tags | Indexed FTS5 keyword/prefix search, plus optional local semantic ranking |
| Screenshot search | Image identifiers and manually assigned tags | Background OCR makes recognized screenshot text available to keyword and semantic search |
| History placement | Panel-menu workflow with an optional mouse-cursor placement setting | Separate shortcut-opened popup, preferring the app's reported text caret and falling back to the pointer |
| Screen edges | Existing GNOME popup placement behavior | Placement flips above the anchor when needed and uses monitor work areas with a 12-pixel margin |
| Tray icon | Opens the history menu | Opens quick settings, archive status, cleanup, and preferences; also offers an Open history action |
| Row actions | Actions are constructed for each entry and controlled by visibility settings | Action icons are shown only on the hovered or keyboard-selected row |
| Retention | Configured history-entry limit and a registry-file size check | No automatic count or size eviction; history grows until explicitly cleared or disk space runs out |
| Development isolation | Original UUID and settings/cache locations | Separate fork UUID, settings path, and SQLite data directory |

The fork keeps the original project's core workflow: clipboard capture, text and
image entries, pinning, tags, text editing, private mode, excluded apps, shortcuts,
and optional paste-on-selection. Those features originate in Clipboard Indicator;
the fork adapts them to the new archive and popup.

## Improvements and their limits

The intended improvement is that opening history and searching a large archive
no longer requires GNOME Shell to process and lay out the entire history. The
popup receives a bounded window of results as you scroll, and new copies update individual records.
Image indexing, embedding indexing, and semantic queries use separate workers.

The included synthetic SQLite benchmark has been run at 1,000, 10,000, and
100,000 entries. In one local 100,000-entry run, p95 helper-query times were
0.11 ms for recent entries, 3.4 ms for a selective keyword query, and 72.13 ms
for a broad keyword query. These figures exclude Shell rendering, clipboard
transfer, and semantic inference. They are not a comparison against an upstream
benchmark or a guarantee of desktop frame times. Re-run `tools/benchmark.py` on
your hardware.

All history processing and inference runs locally. The optional setup command
downloads packages and model weights, not clipboard content. Semantic search
loads cached weights offline during normal use. The model is strongest in English.
Image search uses recognized text and tags; visual object similarity is not implemented.

Unlimited retention does not mean unlimited resources. The archive, attachments,
models, and optional Python runtime consume disk space. Semantic retrieval still
scans stored vectors linearly and indexes only the first 6,000 characters of each
entry; keyword search covers the full text. Approximate vector indexing, semantic
chunking, disk quotas, and broader end-to-end latency measurements remain future work.

### Copy-time lag and upstream issue #428

[Upstream issue #428](https://github.com/Tudmotu/gnome-shell-extension-clipboard-indicator/issues/428)
reports desktop stalls when copying large items or when history contains many
images. Its discussion includes reports of repeatedly hashing/copying retained
images and of large clipboard payloads being handled inside Shell.

The new runtime does not import the legacy `Registry` or `ClipboardEntry` classes.
It does not traverse and rehash stored images on each copy, nor rewrite the entire
archive. Only the incoming payload is hashed, in the helper process. The old
`registry.js` remains in the repository for reference and is not on the active path.

**Do not consider #428 fully resolved in this fork.** Capturing a new item still
requests its full contents through `St.Clipboard` inside Shell, then base64-encodes
and serializes the payload before sending it to the helper. Selecting an item also
returns its full payload through JSON/base64. These operations can still produce
allocation pressure and brief stalls for large images or documents.

An isolated GJS serialization check measured median times of approximately 5.4 ms
for 1 MiB, 7.9 ms for 2 MiB, and 46.4 ms for 8 MiB payloads. It excluded clipboard
transfer, UI rendering, and disk I/O, so it cannot establish total copy latency or
prove that the reported multi-second stalls are gone. A binary/file-based transfer
path and live copy-time profiling are still needed.

Explicit clear-on-login and scheduled clearing remain opt-in. The original
history-size and cache-size settings no longer prune or reset this fork's archive.

## Install

Requires GNOME Shell 46–50, Python 3 with SQLite FTS5, GLib tools, and gettext.
Only GNOME 50 has been smoke-tested for this implementation.

```sh
make all
# Optional local semantic search and screenshot OCR:
bash tools/setup_local_search.sh
make install
```

The development UUID is `clipboard-indicator@lautilosio.github.io`. Disable the
original `clipboard-indicator@tudmotu.com` before enabling the fork to avoid
competing clipboard listeners and shortcut bindings. Log out and back in after
installing or replacing extension modules in a running Wayland session.

The fork uses its own settings path and data directory:

- Settings: `/org/gnome/shell/extensions/clipboard-indicator-fork/`
- Archive: `$XDG_DATA_HOME/clipboard-indicator@lautilosio.github.io/history.sqlite3`
- Attachments, model weights, and optional Python runtime live alongside the database.

On first archive startup, the fork imports its legacy JSON cache transactionally
and records completion. It leaves that cache unchanged. The installed original's
cache is also left unchanged. Import fails visibly if a referenced attachment is
missing; repair the legacy file or restore the attachment before retrying.

To return to upstream, disable the fork and enable the original. Entries captured
by this build remain in the fork database; rollback does not export those entries
into upstream's JSON cache.

## Controls

Use the existing history shortcut, configurable in Preferences. The default is
Control+F9. Click or press Enter on a row to copy it; enable Paste on selection to
paste into the previously focused application. Paste support depends on the app's
Shift+Insert handling. Scroll or use the arrow keys to move through the continuous list. Results load as
needed in either direction, with no Next or Previous buttons. Escape dismisses the popup.

Text inherits GNOME Shell’s font. Popup dimensions track the system text-scaling
factor, and row/icon sizing uses font-relative units.

The active row exposes edit or image preview, pin, tag, and delete icons.
The pin action and pinned indicator use the same native pin symbol. The action
has a checked state when pinned and an accessible Pin or Unpin label.
Control+P toggles pinning, Control+T edits the tag, Control+E edits text, and
Control+Delete deletes the active entry. Deleting pinned entries asks for confirmation.

This build replaces the upstream preferences with controls for the new architecture.
Regex search, text in the top panel, per-copy notifications, and the old row-visibility
options are not implemented. Old settings remain stored for rollback.

## Validation

```sh
python3 -m unittest discover -s tests -v
node tests/placement.mjs
python3 tools/benchmark.py
gjs -m tools/benchmark_transfer.js
# After local search setup, using the runtime's Python:
/path/to/runtime/bin/python tools/test_local_search.py /path/to/models
bash tools/smoke.sh
```

The smoke script runs a separate headless GNOME session with synthetic data and
isolated settings. It checks populated menus, corner placement, active-row actions,
preferences construction, bidirectional lazy scrolling, and cleanup. Set
`ARCHIVE_TEST_TEXT_SCALE=1.5` to exercise 150% text scaling. The process ends through `timeout`, so exit
code 124 is expected. Inspect `ARCHIVE_SMOKE` messages and errors in its output.

Benchmarks cover helper queries at 1k, 10k, and 100k entries. They do not establish
end-to-end popup latency or frame-stall guarantees. The current semantic vector scan
is linear in archive size and indexes the first 6,000 characters of each entry.
Keyword search covers the complete text. An approximate vector index and semantic
chunking are future work for larger archives and long documents.

See [FORK.md](FORK.md) for goals and milestones. Original authorship and license
are preserved in [LICENSE.rst](LICENSE.rst).
