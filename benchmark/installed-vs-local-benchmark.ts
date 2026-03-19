#!/usr/bin/env bun

import { join } from "node:path";

interface ToolConfig {
  label: string;
  cmd: string[];
  cwd: string;
}

interface RunResult {
  tool: string;
  run: number;
  order: number;
  wallMs: number;
  reportedMs: number | null;
  reportedText: string | null;
  foundCount: number | null;
  ok: boolean;
  exitCode: number | null;
  errorMessage?: string;
}

interface SummaryResult {
  tool: string;
  runs: number;
  avgWallMs: number;
  minWallMs: number;
  maxWallMs: number;
  avgReportedMs: number | null;
  foundCount: number | null;
}

interface BenchmarkResults {
  dir: string;
  runs: number;
  outputFile: string;
  summary: SummaryResult[];
  raw: RunResult[];
}

const args = Bun.argv.slice(2);

function getArg(flag: string, fallback: string): string {
  const index = args.indexOf(flag);
  return index !== -1 && args[index + 1] ? args[index + 1]! : fallback;
}

const repoRoot = join(import.meta.dir, "..");
const homeDir = process.env.HOME || process.env.USERPROFILE || "/tmp";
const scanDir = getArg("--dir", homeDir);
const runs = Math.max(1, parseInt(getArg("--runs", "3"), 10));
const timeoutMs = Math.max(60_000, parseInt(getArg("--timeout", "900000"), 10));
const outputFile = join(repoRoot, "benchmark-results-installed-vs-local.json");
const updateCheckFile = join(homeDir, ".bunkill-last-update-check");
const localDistCli = join(repoRoot, "dist", "cli.js");
const localSourceCli = join(repoRoot, "src", "cli.ts");

const tools: ToolConfig[] = [
  {
    label: "installed bunkill",
    cmd: ["bunkill", "--dir", scanDir, "--depth", "10", "--dry-run"],
    cwd: repoRoot,
  },
  {
    label: "local bundled dist",
    cmd: ["bun", localDistCli, "--dir", scanDir, "--depth", "10", "--dry-run"],
    cwd: repoRoot,
  },
  {
    label: "local source cli",
    cmd: ["bun", localSourceCli, "--dir", scanDir, "--depth", "10", "--dry-run"],
    cwd: repoRoot,
  },
];

function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "");
}

function parseReportedMs(text: string | null): number | null {
  if (!text) return null;

  let total = 0;
  const minuteMatch = text.match(/(\d+)m/);
  const secondMatch = text.match(/(\d+(?:\.\d+)?)s/);
  const millisecondMatch = text.match(/(\d+(?:\.\d+)?)ms/);

  if (minuteMatch?.[1]) total += parseInt(minuteMatch[1], 10) * 60_000;
  if (secondMatch?.[1]) total += parseFloat(secondMatch[1]) * 1000;
  if (millisecondMatch?.[1]) total += parseFloat(millisecondMatch[1]);

  return total > 0 ? total : null;
}

async function streamToText(stream: ReadableStream<Uint8Array> | null | undefined): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function primeUpdateCheck(): Promise<void> {
  await Bun.write(updateCheckFile, "");
}

async function ensureLocalBundle(): Promise<void> {
  const distExists = await Bun.file(localDistCli).exists();
  if (distExists) {
    return;
  }

  console.log(`  dist bundle not found at ${localDistCli}`);
  console.log("  Building local bundle (bun run build)...\n");

  const buildProc = Bun.spawn({
    cmd: ["bun", "run", "build"],
    cwd: repoRoot,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "ignore",
  });

  const exitCode = await buildProc.exited;
  if (exitCode !== 0) {
    throw new Error(`Failed to build local bundle (exit code ${exitCode})`);
  }
}

async function runOnce(tool: ToolConfig, run: number, order: number): Promise<RunResult> {
  await primeUpdateCheck();

  const startedAt = performance.now();
  const proc = Bun.spawn({
    cmd: tool.cmd,
    cwd: tool.cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: {
      ...process.env,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
  });

  const stdoutPromise = streamToText(proc.stdout);
  const stderrPromise = streamToText(proc.stderr);

  let exitCode: number | null = null;

  try {
    exitCode = await Promise.race([
      proc.exited,
      new Promise<number>((_, reject) => {
        const timer = setTimeout(() => {
          try {
            proc.kill();
          } catch {
            /* ignore */
          }
          reject(new Error(`Timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        proc.exited.finally(() => clearTimeout(timer));
      }),
    ]);
  } catch (error) {
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    const wallMs = performance.now() - startedAt;
    const output = stripAnsi(`${stdout}\n${stderr}`);

    return {
      tool: tool.label,
      run,
      order,
      wallMs,
      reportedMs: null,
      reportedText: null,
      foundCount: null,
      ok: false,
      exitCode,
      errorMessage: output.trim() || (error instanceof Error ? error.message : String(error)),
    };
  }

  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  const wallMs = performance.now() - startedAt;
  const output = stripAnsi(`${stdout}\n${stderr}`);

  const foundMatch = output.match(/Found\s+(\d+)\s+node_modules directories/i);
  const reportedMatch = output.match(/Scan completed in\s+([^\n]+)/i);
  const reportedText = reportedMatch?.[1]?.trim() ?? null;
  const reportedMs = parseReportedMs(reportedText);
  const foundCount = foundMatch?.[1] ? parseInt(foundMatch[1], 10) : null;
  const ok = exitCode === 0 && foundCount !== null && reportedMs !== null;

  return {
    tool: tool.label,
    run,
    order,
    wallMs,
    reportedMs,
    reportedText,
    foundCount,
    ok,
    exitCode,
    errorMessage: ok ? undefined : output.trim() || `Process exited with code ${exitCode}`,
  };
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function summarize(results: RunResult[]): SummaryResult[] {
  return tools.map((tool) => {
    const toolRuns = results.filter((result) => result.tool === tool.label && result.ok);
    const wallTimes = toolRuns.map((result) => result.wallMs);
    const reportedTimes = toolRuns
      .map((result) => result.reportedMs)
      .filter((value): value is number => value !== null);

    return {
      tool: tool.label,
      runs: toolRuns.length,
      avgWallMs: wallTimes.length > 0 ? average(wallTimes) : 0,
      minWallMs: wallTimes.length > 0 ? Math.min(...wallTimes) : 0,
      maxWallMs: wallTimes.length > 0 ? Math.max(...wallTimes) : 0,
      avgReportedMs: reportedTimes.length > 0 ? average(reportedTimes) : null,
      foundCount: toolRuns[0]?.foundCount ?? null,
    };
  });
}

console.log("\n╔══════════════════════════════════════════════════════════════╗");
console.log("║   BunKill Installed vs Bundled/Source Benchmark           ║");
console.log("╚══════════════════════════════════════════════════════════════╝\n");
console.log(`  Scan root : ${scanDir}`);
console.log(`  Runs      : ${runs} (+ 2 warm-ups)`);
console.log(`  Timeout   : ${formatMs(timeoutMs)}\n`);

await ensureLocalBundle();

console.log("  Warming up...\n");
for (const tool of tools) {
  const warmup = await runOnce(tool, 0, 0);
  const label = warmup.ok
    ? `${warmup.foundCount} found, reported ${warmup.reportedText}`
    : `failed (${warmup.errorMessage ?? "unknown error"})`;
  console.log(`  ${tool.label.padEnd(24)} ${label}`);
}

console.log("\n  Running timed benchmark...\n");

const raw: RunResult[] = [];

for (let run = 1; run <= runs; run++) {
  const runTools = run % 2 === 1 ? tools : [...tools].reverse();

  for (const [index, tool] of runTools.entries()) {
    const result = await runOnce(tool, run, index + 1);
    raw.push(result);

    if (result.ok) {
      console.log(
        `  run ${run} ${tool.label.padEnd(24)} wall=${formatMs(result.wallMs).padStart(8)}  reported=${String(result.reportedText).padStart(8)}  found=${String(result.foundCount).padStart(4)}`,
      );
    } else {
      console.log(
        `  run ${run} ${tool.label.padEnd(24)} failed (${result.errorMessage ?? "unknown error"})`,
      );
    }
  }
}

const summary = summarize(raw);
const output: BenchmarkResults = {
  dir: scanDir,
  runs,
  outputFile,
  summary,
  raw,
};

await Bun.write(outputFile, JSON.stringify(output, null, 2));

console.log("\n  Summary:\n");
for (const item of summary) {
  const reported = item.avgReportedMs !== null ? formatMs(item.avgReportedMs) : "N/A";
  console.log(
    `  ${item.tool.padEnd(24)} avg wall=${formatMs(item.avgWallMs).padStart(8)}  avg reported=${reported.padStart(8)}  found=${String(item.foundCount ?? "N/A").padStart(4)}`,
  );
}

const successful = summary.filter((item) => item.avgReportedMs !== null);
if (successful.length >= 2) {
  const sorted = [...successful].sort((a, b) => (a.avgReportedMs ?? Infinity) - (b.avgReportedMs ?? Infinity));
  const fastest = sorted[0]!;
  const slowest = sorted[sorted.length - 1]!;
  const ratio = (slowest.avgReportedMs ?? 0) / (fastest.avgReportedMs ?? 1);
  console.log(`\n  Fastest: ${fastest.tool}`);
  console.log(`  Speedup: ${ratio.toFixed(2)}x vs ${slowest.tool}`);
}

console.log(`\n  Results saved to: ${outputFile}\n`);
