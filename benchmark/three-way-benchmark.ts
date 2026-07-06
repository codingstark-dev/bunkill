#!/usr/bin/env bun
/**
 * three-way-benchmark.ts
 *
 * Compares BunKill's current scanner against npkill and a simple Bun.Glob walk.
 * This is now JS/Bun-only.
 */

import { join, resolve } from "node:path";
import { scan } from "../src/scanner.ts";

const args = Bun.argv.slice(2);
const getArg = (flag: string, fallback: string) => {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1]! : fallback;
};

const SCAN_DIR = getArg("--dir", process.cwd());
const RUNS = Math.max(1, parseInt(getArg("--runs", "3"), 10));
const MAX_DEPTH = 10;

const SYSTEM_SKIP = [
  "/System", "/Library/Application Support", "/Library/Frameworks",
  "/Applications", "/private", "/dev", "/proc", "/sys",
  "/tmp", "/var/tmp", "/var/log", "/usr/bin", "/usr/sbin",
  "/usr/lib", "/usr/share", "/bin", "/sbin", "/lib", "/lib64",
  "/opt/homebrew", "/usr/local/bin", "/usr/local/sbin",
  ".photolibrary", ".photoslibrary", ".app", ".framework",
] as const;

function shouldSkip(p: string): boolean {
  return SYSTEM_SKIP.some(
    (s) => p.includes(s) || p.toLowerCase().includes(s.toLowerCase()),
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Convert a Windows absolute path to a WSL /mnt/... path. */
function toWslPath(winPath: string): string {
  const normalizedPath = resolve(winPath).replaceAll("\\", "/");
  const driveMatch = /^([A-Za-z]):\/(.*)$/.exec(normalizedPath);
  if (!driveMatch?.[1]) {
    return normalizedPath;
  }

  const drive = driveMatch[1].toLowerCase();
  const rest = driveMatch[2] ?? "";
  return `/mnt/${drive}/${rest}`;
}

async function hasWslNpkill(): Promise<boolean> {
  const probe = Bun.spawn({
    cmd: [
      "wsl",
      "bash",
      "-lc",
      "command -v script >/dev/null && command -v npkill >/dev/null",
    ],
    stdout: "ignore",
    stderr: "ignore",
  });

  return await probe.exited === 0;
}

async function npkillScan(dir: string, useWsl = false): Promise<number> {
  if (useWsl && !(await hasWslNpkill())) {
    return -1;
  }

  const wslCommand = `npkill -d ${shellQuote(toWslPath(dir))} -nu --hide-errors`;
  const scriptCmd = useWsl
    ? ["wsl", "bash", "-lc", `script -q /dev/null -c ${shellQuote(wslCommand)} 2>/dev/null`]
    : ["script", "-q", "/dev/null", "npkill", "-d", dir, "-nu", "--hide-errors"];

  try {
    const proc = Bun.spawn({
      cmd: scriptCmd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
    });

    const chunks: Uint8Array[] = [];
    const reader = proc.stdout.getReader();

    const collectPromise = (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
      } catch {}
    })();

    const killTimer = setTimeout(() => proc.kill(), 15_000);
    await Promise.race([collectPromise, proc.exited]);
    clearTimeout(killTimer);
    try { proc.kill(); } catch {}

    if (await proc.exited !== 0) {
      return -1;
    }

    const raw = Buffer.concat(chunks).toString("utf8");
    const clean = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\r/g, "");

    const lines = clean.split("\n").filter((l) => {
      const t = l.trim();
      return t.endsWith("/node_modules") || t.endsWith("node_modules");
    });

    return lines.length;
  } catch {
    return -1;
  }
}

async function bunGlobScan(dir: string): Promise<number> {
  const results: string[] = [];
  const bunGlob = new Bun.Glob("**/node_modules");

  for await (const relative of bunGlob.scan({
    cwd: dir,
    onlyFiles: false,
    followSymlinks: false,
  })) {
    const normalized = relative.replaceAll("\\", "/");
    const fullPath = join(dir, relative);
    const fullNormalized = fullPath.replaceAll("\\", "/");

    const targetSegments = normalized.split("/")
      .filter((segment) => segment === "node_modules");
    if (targetSegments.length > 1) continue;
    if (shouldSkip(fullNormalized)) continue;

    const depth = normalized.split("/").filter(Boolean).length;
    if (depth > MAX_DEPTH) continue;

    const projectPath = join(fullPath, "..");
    const packageJson = await Bun.file(join(projectPath, "package.json"))
      .json()
      .catch(() => null);
    if (!packageJson) continue;

    results.push(fullPath);
  }

  return results.length;
}

async function bunKillScan(dir: string): Promise<number> {
  const result = await scan({
    dir,
    target: "node_modules",
    exclude: [],
    excludeHidden: false,
    hideErrors: true,
    isFullScan: false,
    depth: MAX_DEPTH,
  });
  return result.modules.length;
}

interface BenchResult {
  label: string;
  avgMs: number;
  minMs: number;
  maxMs: number;
  found: number;
  available: boolean;
  note?: string;
}

async function bench(
  label: string,
  fn: (dir: string) => Promise<number> | number,
  dir: string,
  runs: number,
): Promise<BenchResult> {
  let found = 0;
  try {
    found = await fn(dir);
  } catch {
    return { label, avgMs: 0, minMs: 0, maxMs: 0, found: -1, available: false };
  }

  if (found < 0) {
    return {
      label, avgMs: 0, minMs: 0, maxMs: 0, found: -1, available: false,
      note: "requires TTY or not installed",
    };
  }

  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    found = await fn(dir);
    times.push(performance.now() - t0);
  }

  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  return {
    label,
    avgMs: avg,
    minMs: Math.min(...times),
    maxMs: Math.max(...times),
    found,
    available: true,
  };
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function printRow(r: BenchResult, baseline: number): void {
  // \r\x1b[2K clears any partial line left by WSL/npkill carriage returns
  if (!r.available) {
    process.stdout.write(`\r\x1b[2K  ${r.label.padEnd(24)}  N/A (${r.note ?? "unavailable"})\n`);
    return;
  }

  const speedup = r.avgMs === baseline
    ? "baseline"
    : `${(baseline / r.avgMs).toFixed(1)}x faster`;

  process.stdout.write(
    `\r\x1b[2K  ${r.label.padEnd(24)}  avg=${fmtMs(r.avgMs).padStart(8)}  ` +
    `min=${fmtMs(r.minMs).padStart(8)}  max=${fmtMs(r.maxMs).padStart(8)}  ` +
    `found=${String(r.found).padStart(4)}  ${speedup}\n`,
  );
}

console.log("\n╔══════════════════════════════════════════════════════════════╗");
console.log("║           BunKill Traversal Benchmark                      ║");
console.log("╚══════════════════════════════════════════════════════════════╝\n");
console.log(`  Scan root : ${SCAN_DIR}`);
console.log(`  Runs      : ${RUNS} (+ 1 warm-up)\n`);

const isWindows = process.platform === "win32";

// Detect npkill
const npkillPath = isWindows
  ? await Bun.$.nothrow()`where npkill`.text().then((s) => s.trim().split("\n")[0]?.trim() ?? "").catch(() => "")
  : await Bun.$.nothrow()`which npkill`.text().then((s) => s.trim()).catch(() => "");

const wslAvailable = isWindows
  ? await Bun.$.nothrow()`where wsl`.text().then((s) => s.trim().length > 0).catch(() => false)
  : false;
const wslNpkillAvailable = isWindows && wslAvailable
  ? await hasWslNpkill()
  : false;

const npkillStatus = !npkillPath
  ? "NOT FOUND  (npm install -g npkill)"
  : isWindows && wslNpkillAvailable
    ? `${npkillPath} (via WSL)`
    : isWindows
      ? `${npkillPath} (skipped: WSL npkill/script unavailable)`
      : npkillPath;

console.log(`  npkill    : ${npkillStatus}`);
console.log(`  Bun.Glob  : baseline glob walk`);
console.log(`  bunkill   : current scanner.ts implementation\n`);

console.log("  Running benchmarks...\n");

const [globResult, bunkillResult] = await Promise.all([
  bench("bun glob walk", bunGlobScan, SCAN_DIR, RUNS),
  bench("bunkill current", bunKillScan, SCAN_DIR, RUNS),
]);

// On Windows: run npkill via WSL if available; on Unix: run directly
const canRunNpkill = npkillPath && (!isWindows || wslNpkillAvailable);
const npkillResult = canRunNpkill
  ? await bench("npkill", (d) => npkillScan(d, isWindows && wslAvailable), SCAN_DIR, 1)
  : {
      label: "npkill",
      avgMs: 0, minMs: 0, maxMs: 0, found: -1, available: false,
      note: !npkillPath ? "not installed" : "WSL npkill/script unavailable",
    };

const available = [npkillResult, globResult, bunkillResult].filter((r) => r.available);

if (available.length === 0) {
  console.log("  No implementations available to benchmark.");
  process.exit(1);
}

const slowest = available.reduce((a, b) => a.avgMs > b.avgMs ? a : b);

console.log("  Results:\n");
for (const r of [npkillResult, globResult, bunkillResult]) {
  printRow(r, slowest.avgMs);
}

console.log();
