# BunKill 🚀 - npkill alternative

**Ultra-fast node_modules cleanup tool powered by Bun.js**

> Faster than npkill with advanced interactive features and accurate size reporting

BunKill scans large directory trees, calculates folder sizes, and lets you delete selected `node_modules` folders from an interactive terminal UI or in batch mode.

## Features

- fast scanning for `node_modules` in large trees
- concurrent size calculation with live progress
- interactive cleanup UI with keyboard selection
- interactive search after results load
- multiple sort modes
  - largest first
  - newest first
  - oldest first
  - name
  - path
- developer-friendly badges in the UI
  - package manager
  - git branch / dirty state
  - staged changes
  - recently touched project marker
- dry-run and `--delete-all` modes
- update checks with short timeout and clear status
- JS/Bun implementation only

## Requirements

- Bun is required at runtime
- macOS is the only platform tested so far

Install Bun if needed:

```bash
curl -fsSL https://bun.sh/install | bash
```

## Install

```bash
npm install -g bunkill
```

or

```bash
bun install -g bunkill
```

## Usage

```bash
# interactive scan in current directory
bunkill

# scan a specific directory
bunkill --dir ~/Projects

# preview only
bunkill --dir ~/Projects --dry-run

# delete everything found without interactive selection
bunkill --dir ~/Projects --delete-all

# limit traversal depth
bunkill --dir ~/Projects --depth 3

# check for updates manually
bunkill update --check-only
```

## Options

- `--dir <directory>` scan root, defaults to current directory
- `--target <name>` target folder name, defaults to `node_modules`
- `--exclude <patterns...>` skip paths containing these substrings
- `--exclude-hidden` skip hidden directories
- `--hide-errors` suppress permission errors
- `--full-scan` scan from the home directory
- `--depth <number>` max traversal depth, default `10`
- `--dry-run` show results without deleting
- `--delete-all` delete all discovered targets without interactive selection

## Interactive keys

- `↑` / `↓` move
- `space` select current item
- `/` search loaded results
- `c` clear search
- `a` select or clear all visible results
- `s` cycle sort order
- `d` toggle details
- `o` open directory
- `enter` delete selected
- `q` quit

Search filters the already loaded list, so you can quickly narrow large result sets without rescanning.

## Platform status

- macOS: tested
- Linux: not tested yet
- Windows: not tested yet

Linux and Windows may work, but they have not been validated in this repo yet.

Contributions for Linux and Windows testing or fixes are welcome.

## Performance

Recent real scan on `--dir /Users/himanshum`:

- completed in about `24.45s`
- found `265` `node_modules` directories

More benchmark notes:

- `BENCHMARK.md`
- `benchmark/installed-vs-local-benchmark.ts`
- `benchmark/three-way-benchmark.ts`

## Development

```bash
bun install
bun run check
bun run src/cli.ts --dir ~/Projects --dry-run
```

## Project files

- `src/cli.ts` CLI entry point
- `src/scanner.ts` scan and delete engine
- `src/config.ts` shared runtime and scan config
- `src/types.ts` shared types
- `benchmark/` benchmark scripts

## Contributing

Contributions are welcome.

Especially useful:

- Linux testing
- Windows testing
- terminal UI improvements
- scan performance improvements
- bug reports with reproducible directories or logs

If you are working on `bunkill` or want to contribute around that ecosystem, contributors can get a free on-chain URL from `urls.bid` dm me on x.

## Notes

- BunKill uses Bun at runtime via `#!/usr/bin/env bun`
- the scanner is JS/Bun-only now
- the old Zig/native experiment was removed
- the name "BunKill" is a playful nod to "npkill" and reflects the Bun.js foundation of the tool
