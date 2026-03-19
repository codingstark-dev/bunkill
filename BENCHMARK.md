# BunKill Benchmark Notes

This file documents the benchmark scripts that match the current BunKill codebase.

## Current benchmark scripts

### 1. Installed vs local CLI

Compares three executions on a real directory tree:

- globally installed `bunkill`
- local bundled build (`dist/cli.js`)
- local source CLI (`src/cli.ts`)

Script:

```bash
bun run benchmark/installed-vs-local-benchmark.ts --dir /Users/himanshum --runs 3 --timeout 900000
```

What it measures:

- end-to-end CLI runtime
- BunKill's reported scan time
- discovered `node_modules` count
- alternating run order to reduce cache bias

The script auto-builds `dist/cli.js` if it does not exist.

Latest recorded result values in this file may get stale after scanner changes.
Use the benchmark script output and JSON file as the source of truth.

Output file:

- `benchmark-results-installed-vs-local.json`

### 2. Traversal strategy comparison

Compares the current BunKill scanner with:

- a simple `Bun.Glob` walk
- `npkill` when available

Script:

```bash
bun run benchmark/three-way-benchmark.ts --dir /Users/himanshum --runs 3
```

Notes:

- this benchmark is JS/Bun-only and reflects the current architecture
- the older Zig/native scanner has been removed
- `npkill` may be unavailable or may behave differently in non-interactive environments

## Performance conclusions so far

- the JS/Bun scanner is the default and only implementation now
- the removed Zig/native experiment was slower on the real `/Users/himanshum` workload
- the scan UX was improved so progress becomes visible almost immediately instead of appearing stuck at `0 node_modules found`
- current tuning keeps the near-immediate progress updates without regressing full scan time back to the slower intermediate versions

## Recommended validation flow

For normal development:

```bash
bun run check
bun run src/cli.ts --dir ~/Projects --dry-run
```

For performance validation on the real tree used in this work:

```bash
bun run benchmark/installed-vs-local-benchmark.ts --dir /Users/himanshum --runs 3 --timeout 900000
bun run benchmark/three-way-benchmark.ts --dir /Users/himanshum --runs 3
```

## Important context

- benchmark numbers depend heavily on filesystem cache state and the exact tree contents
- use repeated runs when comparing changes
- prefer the installed-vs-local benchmark when validating user-visible improvement of the CLI
