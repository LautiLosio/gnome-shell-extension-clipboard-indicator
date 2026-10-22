# Clipboard Indicator Fork

A fork of [Tudmotu's Clipboard Indicator](https://github.com/Tudmotu/gnome-shell-extension-clipboard-indicator)
for large local histories and a separate floating history popup.

## Current implementation

- SQLite storage and FTS5 keyword search in a private Python helper process.
- Incremental writes and content-hash deduplication; no whole-history JSON rewrites.
- Unlimited retention by default, constrained by available disk space.
- Thirty results per page, including pinned results. Shell never constructs a row for every stored entry.
- Local semantic retrieval through FastEmbed and MiniLM, combined with keyword rankings.
- Background screenshot OCR through RapidOCR and 96-pixel image thumbnails.
- Separate workers for image indexing, embedding indexing, and semantic queries.
- A history shortcut opens at the input caret where the application reports it,
  falling back to the mouse pointer. Placement flips above the anchor near the
  bottom and respects the monitor work area with a 12-pixel margin.
- The tray icon opens capture controls, archive status, cleanup, and preferences.
- Row action icons appear only on the active row, selected by pointer hover or keyboard focus.

All history processing and inference runs locally. The optional setup command
downloads packages and model weights, not clipboard content. Semantic search
loads cached weights offline during normal use. The model is strongest in English.
Image search uses recognized text and tags; visual object similarity is not implemented.

This is an experimental architecture change. The old history-size and cache-size
settings no longer prune or reset the archive. Explicit clear-on-login and scheduled
clearing remain opt-in. Disk use includes the optional runtime and models.

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
Shift+Insert handling. Arrow keys navigate the current page; use Next and Previous
for more results. Escape dismisses the popup.

The active row exposes edit or image preview, pin, tag, and delete icons.
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
# After local search setup, using the runtime's Python:
/path/to/runtime/bin/python tools/test_local_search.py /path/to/models
bash tools/smoke.sh
```

The smoke script runs a separate headless GNOME session with synthetic data and
isolated settings. It checks populated menus, corner placement, active-row actions,
preferences construction, and cleanup. The process ends through `timeout`, so exit
code 124 is expected. Inspect `ARCHIVE_SMOKE` messages and errors in its output.

Benchmarks cover helper queries at 1k, 10k, and 100k entries. They do not establish
end-to-end popup latency or frame-stall guarantees. The current semantic vector scan
is linear in archive size and indexes the first 6,000 characters of each entry.
Keyword search covers the complete text. An approximate vector index and semantic
chunking are future work for larger archives and long documents.

See [FORK.md](FORK.md) for goals and milestones. Original authorship and license
are preserved in [LICENSE.rst](LICENSE.rst).
