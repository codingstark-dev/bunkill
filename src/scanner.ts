import { readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { APP_CONFIG, SCAN_PATHS } from "./config.ts";
import type { DeleteResult, NodeModule, ScanOptions, ScanResult } from "./types.ts";

class Semaphore {
  private _count: number;
  private _queue: Array<() => void> = [];

  constructor(limit: number) {
    this._count = limit;
  }

  acquire(): Promise<void> {
    if (this._count > 0) {
      this._count--;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this._queue.push(resolve));
  }

  release(): void {
    if (this._queue.length > 0) {
      const next = this._queue.shift()!;
      next();
    } else {
      this._count++;
    }
  }
}

const PERMISSION_ERROR_CODES = new Set(SCAN_PATHS.permissionErrorCodes);

function shouldSkip(dirPath: string): boolean {
  const np = normalizeSep(dirPath);
  const isAllowedCache = SCAN_PATHS.allowCachePatterns.some(
    (p) =>
      np.includes(p) &&
      !SCAN_PATHS.skipCacheSubdirs.some((skip) => np.includes(skip)),
  );
  if (isAllowedCache) return false;
  if (np.includes(".npm/_npx")) return false;

  return SCAN_PATHS.systemSkipPatterns.some(
    (p) =>
      np.includes(p) ||
      np.toLowerCase().includes(p.toLowerCase()),
  );
}

const IS_WINDOWS = process.platform === "win32";

function normalizeSep(p: string): string {
  return IS_WINDOWS ? p.replaceAll("\\", "/") : p;
}

/** Strip trailing /<target> segment and normalize separators. */
export function normalizeProjectPath(nmPath: string, target = "node_modules"): string {
  return normalizeSep(nmPath).replace(new RegExp(`/${target}$`), "");
}

function isWithinRoot(path: string, root: string): boolean {
  const np = normalizeSep(path);
  const nr = normalizeSep(root);
  return np === nr || np.startsWith(`${nr}/`);
}

function hasHiddenPathSegment(dirPath: string, root: string): boolean {
  const np = normalizeSep(dirPath);
  const nr = normalizeSep(root);

  const relativePath = np.startsWith(`${nr}/`)
    ? np.slice(nr.length + 1)
    : np === nr
      ? ""
      : np;

  if (!relativePath) {
    return false;
  }

  return relativePath.split("/").some((segment) =>
    segment.startsWith(".") && segment !== "." && segment !== ".."
  );
}

function createShouldSkipMatcher(options: ScanOptions): (dirPath: string) => boolean {
  if (options.isFullScan) {
    return shouldSkip;
  }

  const roots = [options.dir].filter(Boolean);

  return (dirPath: string) => {
    const matchingRoot = roots.find((root) => isWithinRoot(dirPath, root));
    if (!matchingRoot) {
      return shouldSkip(dirPath);
    }

    if (options.excludeHidden && hasHiddenPathSegment(dirPath, matchingRoot)) {
      return true;
    }

    const np = normalizeSep(dirPath);
    const nr = normalizeSep(matchingRoot);
    const lowerNp = np.toLowerCase();
    const lowerNr = nr.toLowerCase();

    const isAllowedCache = SCAN_PATHS.allowCachePatterns.some(
      (pattern) =>
        np.includes(pattern) &&
        !SCAN_PATHS.skipCacheSubdirs.some((skip) => np.includes(skip)),
    );
    if (isAllowedCache || np.includes(".npm/_npx")) {
      return false;
    }

    return SCAN_PATHS.systemSkipPatterns.some((pattern) => {
      const matchesPattern =
        np.includes(pattern) || lowerNp.includes(pattern.toLowerCase());
      if (!matchesPattern) {
        return false;
      }

      const rootIncludesPattern =
        nr.includes(pattern) || lowerNr.includes(pattern.toLowerCase());
      return !rootIncludesPattern;
    });
  };
}

async function readPackageMetadata(projectPath: string): Promise<{
  packageName: string;
  packageVersion: string;
  isActive: boolean;
  packageManager?: string;
  projectLastModified?: Date;
}> {
  const packageJsonPath = join(projectPath, "package.json");
  const packageFile = Bun.file(packageJsonPath);
  const fallbackName = basename(projectPath);

  const normalizePackageManager = (value?: string): string | undefined => {
    const raw = value?.trim();
    if (!raw) return undefined;
    return raw.split("@")[0]?.trim().toLowerCase() || undefined;
  };

  const [pkg, pkgStat] = await Promise.all([
    packageFile.json().catch(() => null as {
      name?: string;
      version?: string;
      packageManager?: string;
    } | null),
    packageFile.stat().catch(() => null),
  ]);

  const packageName = pkg?.name ?? fallbackName;
  const packageVersion = pkg?.version ?? "unknown";
  const packageManager = normalizePackageManager(pkg?.packageManager);
  const isActive = pkgStat
    ? ((Date.now() - pkgStat.mtime.getTime()) / (1000 * 60 * 60 * 24)) < 30
    : false;

  return {
    packageName,
    packageVersion,
    isActive,
    packageManager,
    projectLastModified: pkgStat?.mtime,
  };
}

async function getDirectorySize(dirPath: string): Promise<number> {
  if (!IS_WINDOWS) {
    try {
      const proc = Bun.spawn({
        cmd: ["du", "-sk", dirPath],
        stdout: "pipe",
        stderr: "ignore",
      });
      const output = await (new Response(proc.stdout) as globalThis.Response).text();
      if (await proc.exited === 0) {
        const match = output.match(/^(\d+)/);
        if (match?.[1]) return parseInt(match[1], 10) * 1024;
      }
    } catch {
      /* ignore */
    }
  }

  let total = 0;
  try {
    const glob = new Bun.Glob("**/*");
    for await (const file of glob.scan({ cwd: dirPath, onlyFiles: true, dot: true })) {
      try {
        const s = await Bun.file(join(dirPath, file)).stat();
        total += s.size;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return total;
}

async function discoverNodeModulesWithFs(
  root: string,
  maxDepth: number,
  options: ScanOptions,
  shouldSkipPath: (dirPath: string) => boolean,
  callbacks?: {
    onVisit?: (path: string) => void;
    onHit?: (path: string) => void;
  },
): Promise<string[]> {
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  const hits: string[] = [];

  while (queue.length > 0) {
    const batch = queue.splice(0, 64);

    await Promise.all(batch.map(async ({ path, depth }) => {
      callbacks?.onVisit?.(path);

      if (depth > maxDepth) {
        return;
      }
      if (shouldSkipPath(path)) {
        return;
      }

      let entries;
      try {
        entries = await readdir(path, { withFileTypes: true });
      } catch (error) {
        const code = error instanceof Error && "code" in error
          ? String((error as NodeJS.ErrnoException).code)
          : "";
        if (!PERMISSION_ERROR_CODES.has(code as typeof SCAN_PATHS.permissionErrorCodes[number]) && !options.hideErrors) {
          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(`[scanner] error in ${path}: ${message}\n`);
        }
        return;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        const fullPath = join(path, entry.name);
        if (shouldSkipPath(fullPath)) {
          continue;
        }
        if (options.exclude.some((ex) => fullPath.includes(ex))) {
          continue;
        }
        if (options.excludeHidden && entry.name.startsWith(".")) {
          continue;
        }

        if (entry.name === options.target) {
          // Detect nesting: check if the normalized path contains /target/ as a segment
          const normalizedFull = normalizeSep(fullPath);
          const segmentMarker = "/" + options.target + "/";
          if (normalizedFull.includes(segmentMarker)) {
            continue;
          }
          hits.push(fullPath);
          callbacks?.onHit?.(fullPath);
          continue;
        }

        queue.push({ path: fullPath, depth: depth + 1 });
      }
    }));
  }

  return hits;
}

async function processModuleMeta(
  nmPath: string,
  projectPath: string,
): Promise<NodeModule | null> {
  try {
    const metadata = await readPackageMetadata(projectPath);
    const s = await Bun.file(nmPath).stat();

    return {
      path: nmPath,
      packageName: metadata.packageName,
      packageVersion: metadata.packageVersion,
      packageManager: metadata.packageManager,
      size: 0,
      lastModified: s.mtime,
      projectLastModified: metadata.projectLastModified,
      isActive: metadata.isActive,
    };
  } catch {
    return null;
  }
}

export async function scan(options: ScanOptions): Promise<ScanResult> {
  const startTime = performance.now();
  const shouldSkipPath = createShouldSkipMatcher(options);

  const results: Array<NodeModule | undefined> = [];
  let foundCount = 0;
  let sizedCompleted = 0;
  let sizedPending = 0;
  let lastProgressAt = 0;
  let discoveryDone = false;

  const maxDepth = options.depth ?? 10;
  const scanRoots = options.isFullScan
    ? [require("os").homedir() as string]
    : [options.dir];

  const emitProgress = (
    phase: "discovering" | "sizing" | "complete",
    current: string,
    force = false,
  ) => {
    const now = Date.now();
    if (!force && now - lastProgressAt < 100) {
      return;
    }
    lastProgressAt = now;
    options.onProgress?.({
      found: foundCount,
      current,
      sizedCompleted,
      sizedPending,
      phase,
    });
  };

  const sizeSemaphore = new Semaphore(APP_CONFIG.defaultSizeConcurrency);
  const metaSemaphore = new Semaphore(Math.max(8, APP_CONFIG.defaultSizeConcurrency * 2));
  const pendingModuleTasks = new Set<Promise<void>>();

  const scheduleModuleProcessing = (nmPath: string, index: number): void => {
    const task = (async () => {
      let mod: NodeModule | null = null;

      await metaSemaphore.acquire();
      const projectPath = normalizeProjectPath(nmPath, options.target);
      try {
        mod = await processModuleMeta(nmPath, projectPath);
      } finally {
        metaSemaphore.release();
      }

      if (!mod) {
        return;
      }

      results[index] = mod;
      options.onModule?.(mod);

      sizedPending++;
      emitProgress(discoveryDone ? "sizing" : "discovering", nmPath, true);

      await sizeSemaphore.acquire();
      try {
        const size = await getDirectorySize(nmPath);
        mod.size = size;
        options.onModuleUpdate?.(nmPath, size);
      } finally {
        sizeSemaphore.release();
      }

      sizedPending--;
      sizedCompleted++;
      emitProgress(discoveryDone ? "sizing" : "discovering", nmPath, true);
    })()
      .catch(() => {
        /* ignore per-module failures */
      })
      .finally(() => {
        pendingModuleTasks.delete(task);
      });

    pendingModuleTasks.add(task);
  };

  const scanRoot = async (root: string): Promise<void> => {
    try {
      let hitIndex = foundCount;
      const callbacks = {
        onVisit: (path: string) => {
          emitProgress(discoveryDone ? "sizing" : (sizedPending > 0 ? "sizing" : "discovering"), path);
        },
        onHit: (path: string) => {
          const index = hitIndex++;
          foundCount = hitIndex;
          scheduleModuleProcessing(path, index);
          emitProgress("discovering", path, true);
        },
      };

      await discoverNodeModulesWithFs(
        root,
        maxDepth,
        options,
        shouldSkipPath,
        callbacks,
      );
    } catch (err: unknown) {
      if (!options.hideErrors) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[scanner] error in ${root}: ${msg}\n`);
      }
    }
  };

  await Promise.allSettled(scanRoots.map(scanRoot));
  discoveryDone = true;
  if (pendingModuleTasks.size > 0) {
    emitProgress("sizing", scanRoots[0] ?? options.dir, true);
    await Promise.allSettled(Array.from(pendingModuleTasks));
  }
  emitProgress("complete", scanRoots[0] ?? options.dir, true);

  return {
    modules: results.filter((mod): mod is NodeModule => mod !== undefined),
    elapsedMs: performance.now() - startTime,
  };
}

// ---------------------------------------------------------------------------
// Delete helper
// ---------------------------------------------------------------------------
export async function deleteModules(
  modules: NodeModule[],
): Promise<DeleteResult> {
  const start = performance.now();
  let deleted = 0;
  let freed = 0;
  const failedPaths: string[] = [];
  const deletedPaths: string[] = [];

  for (const mod of modules) {
    try {
      await rm(mod.path, { recursive: true, force: true });
      deleted++;
      freed += mod.size;
      deletedPaths.push(mod.path);
    } catch {
      failedPaths.push(mod.path);
    }
  }

  return {
    deleted,
    freed,
    elapsedMs: performance.now() - start,
    failedPaths,
    deletedPaths,
  };
}
