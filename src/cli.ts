#!/usr/bin/env bun

import { program } from "commander";
import { stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { filesize } from "filesize";
import { APP_CONFIG } from "./config.ts";
import { deleteModules, scan as scanEngine } from "./scanner.ts";
import type { NodeModule, ScanOptions } from "./types.ts";

const LOGO = `
\x1b[36m +-+-+-+-+-+-+-+\x1b[0m
\x1b[36m |B|u|n|K|i|l|l|\x1b[0m
\x1b[36m +-+-+-+-+-+-+-+\x1b[0m
\x1b[35m        🚀 Created by codingstark.com\x1b[0m
`;

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
} as const;

type SortMode =
  | "size-desc"
  | "modified-desc"
  | "modified-asc"
  | "name-asc"
  | "path-asc";

interface UiModuleMeta {
  git?: {
    isRepo: boolean;
    branch?: string;
    dirty?: boolean;
    staged?: boolean;
  };
}

function formatBytes(bytes: number, round = 1): string {
  return filesize(bytes, { round });
}

function formatElapsedTime(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(1);
  return `${minutes}m ${seconds}s`;
}

function getModuleActivityDate(module: NodeModule): Date {
  return module.projectLastModified ?? module.lastModified;
}

function truncatePath(value: string, maxLength = 50): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `...${value.slice(-(maxLength - 3))}`;
}

function clampCursor(nextIndex: number, length: number): number {
  if (length <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(length - 1, nextIndex));
}

function safeSetRawMode(enabled: boolean): void {
  if (process.stdin.setRawMode) {
    process.stdin.setRawMode(enabled);
  }
}

async function fetchLatestVersion(): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), APP_CONFIG.updateCheckTimeoutMs);

  try {
    const response = await fetch(
      `https://registry.npmjs.org/${APP_CONFIG.packageName}/latest`,
      { signal: controller.signal },
    ) as globalThis.Response;
    if (!response.ok) {
      return null;
    }

    const data = await response.json() as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

class BunKill {
  private nodeModules: NodeModule[] = [];
  private selectedPaths = new Set<string>();
  private cursorIndex = 0;
  private showDetails = false;
  private sortBy: SortMode = "size-desc";
  private latestVersion: string | null = null;
  private hasUpdate = false;
  private lastSearchTime = 0;
  private uiMeta = new Map<string, UiModuleMeta>();
  private pendingUiMeta = new Set<string>();
  private rerender: (() => void) | null = null;
  private rerenderTimer: ReturnType<typeof setTimeout> | null = null;
  private stdinHandler: ((key: string) => void) | null = null;
  private searchQuery = "";
  private searchDraft = "";
  private searchBeforeEdit = "";
  private searchMode = false;

  async scan(options: ScanOptions): Promise<NodeModule[]> {
    await this.checkDailyUpdate();

    console.log(
      `${colors.blue}🔍 Scanning for node_modules directories...${colors.reset}`,
    );
    console.log(`${colors.gray}BunKill v${APP_CONFIG.currentVersion}${colors.reset}\n`);

    let foundNodeModules = 0;
    let sizedCompleted = 0;
    let sizedPending = 0;
    let scanPhase: "discovering" | "sizing" | "complete" = "discovering";
    let currentScanPath = "";

    const progressInterval = setInterval(() => {
      const phaseLabel = scanPhase === "sizing"
        ? `sizing ${sizedCompleted} done, ${sizedPending} pending`
        : scanPhase === "complete"
          ? "finalizing"
          : "discovering";

      process.stdout.write(
        `\r${colors.cyan}⏳${colors.reset} ${truncatePath(currentScanPath || "scanning...")} | ${foundNodeModules} node_modules found | ${phaseLabel}`,
      );
    }, 100);

    try {
      const { modules, elapsedMs } = await scanEngine({
        ...options,
        onProgress: (progress) => {
          foundNodeModules = progress.found;
          currentScanPath = progress.current;
          sizedCompleted = progress.sizedCompleted;
          sizedPending = progress.sizedPending;
          scanPhase = progress.phase;
        },
      });

      this.nodeModules = modules;
      this.selectedPaths.clear();
      this.cursorIndex = 0;
      this.searchQuery = "";
      this.searchDraft = "";
      this.searchBeforeEdit = "";
      this.searchMode = false;
      this.uiMeta.clear();
      this.pendingUiMeta.clear();
      this.lastSearchTime = elapsedMs;

      console.log(
        `\n${colors.green}\x1b[1m✅\x1b[0m Scan completed in ${formatElapsedTime(elapsedMs)}${colors.reset}`,
      );
      console.log(
        `${colors.blue}\x1b[1m📊\x1b[0m Found ${modules.length} node_modules directories${colors.reset}`,
      );

      return modules;
    } finally {
      clearInterval(progressInterval);
    }
  }

  async interactiveDelete(): Promise<void> {
    if (this.nodeModules.length === 0) {
      console.log(`${colors.yellow}No node_modules found to delete.${colors.reset}`);
      return;
    }

    const versionText = this.hasUpdate
      ? `${colors.yellow}v${APP_CONFIG.currentVersion} 📦${colors.reset}`
      : `${colors.cyan}v${APP_CONFIG.currentVersion}${colors.reset}`;

    try {
      safeSetRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding("utf8");
    } catch (error) {
      console.error(
        `${colors.red}Error setting up interactive mode:${colors.reset}`,
        error,
      );
      console.log(
        `${colors.yellow}Falling back to non-interactive mode...${colors.reset}`,
      );
      return;
    }

    const render = () => {
      const visibleModules = this.getVisibleModules();
      this.cursorIndex = clampCursor(this.cursorIndex, visibleModules.length);

      console.clear();
      console.log(LOGO);
      console.log(
        `${colors.bold}${colors.blue}Found ${this.nodeModules.length} node_modules directories${colors.reset} ${colors.gray}(search took ${formatElapsedTime(this.lastSearchTime)}, showing ${visibleModules.length})${colors.reset}`,
      );
      console.log(
        `${versionText} | ${colors.gray}Use ↑/↓ to navigate, SPACE to select, ENTER to delete, q to quit${colors.reset}`,
      );

      if (this.hasUpdate && this.latestVersion) {
        console.log(
          `${colors.yellow}📦 Update available: ${colors.white}${this.latestVersion}${colors.yellow} - run 'bunkill update'${colors.reset}`,
        );
      }

      console.log(
        `${colors.gray}Press / to search, a to select visible, s to sort, d to toggle details, o to open directory${colors.reset}`,
      );
      console.log(
        `${colors.gray}Sort: ${this.getSortLabel()} | Filter: ${this.getSearchLabel()}${this.searchMode ? " (editing)" : ""}${colors.reset}\n`,
      );

      const visibleRange = 20;
      const startIndex = Math.max(0, this.cursorIndex - Math.floor(visibleRange / 2));
      const endIndex = Math.min(visibleModules.length, startIndex + visibleRange);

      void this.prefetchVisibleDetails(visibleModules.slice(startIndex, endIndex));

      if (visibleModules.length === 0) {
        console.log(
          `${colors.yellow}No results for the current filter.${colors.reset}`,
        );
      }

      for (let i = startIndex; i < endIndex; i++) {
        const module = visibleModules[i]!;
        const isSelected = this.selectedPaths.has(module.path);
        const isCursor = i === this.cursorIndex;
        const sizeStr = formatBytes(module.size);
        const recency = this.formatRelativeTime(getModuleActivityDate(module));
        const badges = this.getBadges(module);

        let line = isCursor
          ? `${colors.cyan}\x1b[1m>\x1b[0m `
          : "  ";

        line += isSelected
          ? `${colors.green}\x1b[1m[✓]\x1b[0m `
          : "[ ] ";

        if (this.showDetails) {
          line += `${colors.white}${module.packageName}@${module.packageVersion}${colors.reset} `;
          if (badges) {
            line += `${badges} `;
          }
          line += `${colors.gray}(${sizeStr}, used ${recency}) ${colors.reset}`;
          line += `${colors.blue}${module.path}${colors.reset}`;
        } else {
          line += `${colors.white}${module.packageName}${colors.reset} `;
          line += `${colors.gray}${sizeStr}${colors.reset} `;
          if (badges) {
            line += `${badges} `;
          }
          line += `${colors.blue}${basename(module.path)}${colors.reset}`;
        }

        if (module.isActive) {
          line += `${colors.green} \x1b[1m[ACTIVE]\x1b[0m${colors.reset}`;
        }

        console.log(line);
      }

      const totalSelectedSize = this.nodeModules
        .filter((module) => this.selectedPaths.has(module.path))
        .reduce((sum, module) => sum + module.size, 0);

      console.log(
        `${colors.yellow}\nSelected: ${this.selectedPaths.size} folders, ${formatBytes(totalSelectedSize)}${colors.reset}`,
      );
      console.log(
        `${colors.gray}Badges: [bun/npm/pnpm/yarn] package manager, [branch*] git dirty state, [staged], [recent] recently touched project${colors.reset}`,
      );

      if (this.searchMode) {
        console.log(
          `${colors.gray}Search mode: type to filter, Enter to apply, Esc to cancel, Backspace to edit${colors.reset}`,
        );
      }
    };

    this.rerender = render;

    const handleKey = (key: string) => {
      const visibleModules = this.getVisibleModules();

      if (this.searchMode) {
        switch (key) {
          case "\u0003":
            this.cleanupInteractiveSession();
            console.log(`${colors.green}\nGoodbye! 👋${colors.reset}`);
            process.exit(0);
            return;
          case "\u001b":
            this.searchMode = false;
            this.searchDraft = this.searchBeforeEdit;
            render();
            return;
          case "\r":
            this.searchMode = false;
            this.searchQuery = this.searchDraft.trim();
            this.cursorIndex = 0;
            render();
            return;
          case "\u007f":
          case "\b":
            this.searchDraft = this.searchDraft.slice(0, -1);
            render();
            return;
          default:
            if (!key.startsWith("\u001b")) {
              this.searchDraft += key;
              this.cursorIndex = 0;
              render();
            }
            return;
        }
      }

      switch (key) {
        case "\u0003":
        case "q":
        case "Q":
          this.cleanupInteractiveSession();
          console.log(`${colors.green}\nGoodbye! 👋${colors.reset}`);
          process.exit(0);
          return;
        case "\u001b[A":
          this.cursorIndex = Math.max(0, this.cursorIndex - 1);
          break;
        case "\u001b[B":
          this.cursorIndex = clampCursor(this.cursorIndex + 1, visibleModules.length);
          break;
        case "\u001b[5~":
          this.cursorIndex = clampCursor(this.cursorIndex - 10, visibleModules.length);
          break;
        case "\u001b[6~":
          this.cursorIndex = clampCursor(this.cursorIndex + 10, visibleModules.length);
          break;
        case "\u001b[H":
        case "\u001b[1~":
          this.cursorIndex = 0;
          break;
        case "\u001b[F":
        case "\u001b[4~":
          this.cursorIndex = clampCursor(visibleModules.length - 1, visibleModules.length);
          break;
        case " ":
          this.toggleCurrentSelection(visibleModules);
          break;
        case "\r":
          if (visibleModules.length === 0) {
            break;
          }
          void this.deleteSelected();
          return;
        case "s":
        case "S":
          this.cycleSort();
          this.cursorIndex = 0;
          break;
        case "d":
        case "D":
          this.showDetails = !this.showDetails;
          break;
        case "o":
        case "O": {
          const current = visibleModules[this.cursorIndex];
          if (current) {
            void this.openDirectory(current);
          }
          break;
        }
        case "a":
        case "A":
          this.toggleSelectAllVisible(visibleModules);
          break;
        case "/":
          this.searchMode = true;
          this.searchBeforeEdit = this.searchQuery;
          this.searchDraft = this.searchQuery;
          break;
        case "c":
        case "C":
          this.searchQuery = "";
          this.searchDraft = "";
          this.cursorIndex = 0;
          break;
      }

      render();
    };

    this.stdinHandler = handleKey;
    process.stdin.on("data", handleKey);
    render();
  }

  private cleanupInteractiveSession(): void {
    if (this.stdinHandler) {
      process.stdin.removeListener("data", this.stdinHandler);
      this.stdinHandler = null;
    }

    if (this.rerenderTimer) {
      clearTimeout(this.rerenderTimer);
      this.rerenderTimer = null;
    }

    this.rerender = null;
    safeSetRawMode(false);
    process.stdin.pause();
  }

  private getVisibleModules(): NodeModule[] {
    const query = this.getActiveSearchQuery();
    const sorted = this.getSortedModules();

    if (!query) {
      return sorted;
    }

    return sorted.filter((module) => this.matchesSearch(module, query));
  }

  private matchesSearch(module: NodeModule, query: string): boolean {
    const haystack = [
      module.packageName,
      module.packageVersion,
      module.packageManager,
      module.path,
      basename(module.path),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return haystack.includes(query);
  }

  private getActiveSearchQuery(): string {
    return (this.searchMode ? this.searchDraft : this.searchQuery).trim().toLowerCase();
  }

  private getSearchLabel(): string {
    const query = this.searchMode ? this.searchDraft : this.searchQuery;
    return query.trim() || "none";
  }

  private getSortedModules(): NodeModule[] {
    const sorted = [...this.nodeModules];

    sorted.sort((a, b) => {
      switch (this.sortBy) {
        case "size-desc":
          return b.size - a.size;
        case "modified-desc":
          return getModuleActivityDate(b).getTime() - getModuleActivityDate(a).getTime();
        case "modified-asc":
          return getModuleActivityDate(a).getTime() - getModuleActivityDate(b).getTime();
        case "name-asc":
          return (a.packageName ?? basename(a.path)).localeCompare(
            b.packageName ?? basename(b.path),
          );
        case "path-asc":
          return a.path.localeCompare(b.path);
      }
    });

    return sorted;
  }

  private cycleSort(): void {
    const sorts: SortMode[] = [
      "size-desc",
      "modified-desc",
      "modified-asc",
      "name-asc",
      "path-asc",
    ];
    const currentIndex = sorts.indexOf(this.sortBy);
    this.sortBy = sorts[(currentIndex + 1) % sorts.length]!;
  }

  private getSortLabel(): string {
    switch (this.sortBy) {
      case "size-desc":
        return "largest first";
      case "modified-desc":
        return "newest first";
      case "modified-asc":
        return "oldest first";
      case "name-asc":
        return "name";
      case "path-asc":
        return "path";
    }
  }

  private toggleCurrentSelection(visibleModules: NodeModule[]): void {
    const current = visibleModules[this.cursorIndex];
    if (!current) {
      return;
    }

    if (this.selectedPaths.has(current.path)) {
      this.selectedPaths.delete(current.path);
    } else {
      this.selectedPaths.add(current.path);
    }
  }

  private toggleSelectAllVisible(visibleModules: NodeModule[]): void {
    const allVisibleSelected = visibleModules.length > 0 &&
      visibleModules.every((module) => this.selectedPaths.has(module.path));

    if (allVisibleSelected) {
      visibleModules.forEach((module) => this.selectedPaths.delete(module.path));
      return;
    }

    visibleModules.forEach((module) => this.selectedPaths.add(module.path));
  }

  private async prefetchVisibleDetails(modules: NodeModule[]): Promise<void> {
    await Promise.allSettled(modules.map((module) => this.loadUiMeta(module)));
  }

  private async loadUiMeta(module: NodeModule): Promise<void> {
    if (this.uiMeta.has(module.path) || this.pendingUiMeta.has(module.path)) {
      return;
    }

    this.pendingUiMeta.add(module.path);
    const projectPath = module.path.replace(/\/node_modules$/, "");

    try {
      const result = await Bun.$`git -C ${projectPath} status --short --branch`.quiet().nothrow();
      if (result.exitCode !== 0) {
        this.uiMeta.set(module.path, { git: { isRepo: false } });
        return;
      }

      const output = result.stdout.toString().replace(/\r/g, "");
      const lines = output.split("\n").filter(Boolean);
      const branchLine = lines[0] ?? "";
      const branch = branchLine.startsWith("## ")
        ? branchLine.slice(3).split("...")[0]?.trim()
        : undefined;
      const dirtyLines = lines.slice(1);
      const dirty = dirtyLines.length > 0;
      const staged = dirtyLines.some((line) => {
        const status = line.slice(0, 2);
        return status[0] && status[0] !== " " && status[0] !== "?";
      });

      this.uiMeta.set(module.path, {
        git: {
          isRepo: true,
          branch,
          dirty,
          staged,
        },
      });

      this.scheduleRerender();
    } catch {
      this.uiMeta.set(module.path, { git: { isRepo: false } });
    } finally {
      this.pendingUiMeta.delete(module.path);
    }
  }

  private scheduleRerender(): void {
    if (!this.rerender || this.rerenderTimer) {
      return;
    }

    this.rerenderTimer = setTimeout(() => {
      this.rerenderTimer = null;
      this.rerender?.();
    }, 120);
  }

  private getBadges(module: NodeModule): string {
    const parts: string[] = [];

    if (module.packageManager) {
      parts.push(`${colors.magenta}[${module.packageManager}]${colors.reset}`);
    }

    const git = this.uiMeta.get(module.path)?.git;
    if (git?.isRepo) {
      const branch = git.branch ?? "git";
      const dirtyMarker = git.dirty ? `${colors.yellow}*${colors.reset}` : "";
      parts.push(`${colors.cyan}[${branch}${dirtyMarker}]${colors.reset}`);
      if (git.staged) {
        parts.push(`${colors.yellow}[staged]${colors.reset}`);
      }
    }

    if (this.isRecent(getModuleActivityDate(module), 14)) {
      parts.push(`${colors.green}[recent]${colors.reset}`);
    }

    return parts.join(" ");
  }

  private isRecent(date: Date, days: number): boolean {
    return Date.now() - date.getTime() < days * 24 * 60 * 60 * 1000;
  }

  private formatRelativeTime(date: Date): string {
    const diffMs = Date.now() - date.getTime();
    const diffMinutes = Math.floor(diffMs / (60 * 1000));
    const diffHours = Math.floor(diffMs / (60 * 60 * 1000));
    const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));

    if (diffMinutes < 1) return "just now";
    if (diffMinutes < 60) return `${diffMinutes}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 30) return `${diffDays}d ago`;
    const diffMonths = Math.floor(diffDays / 30);
    if (diffMonths < 12) return `${diffMonths}mo ago`;
    const diffYears = Math.floor(diffDays / 365);
    return `${diffYears}y ago`;
  }

  private async deleteSelected(): Promise<void> {
    const toDelete = this.nodeModules.filter((module) => this.selectedPaths.has(module.path));
    if (toDelete.length === 0) {
      return;
    }

    this.cleanupInteractiveSession();

    console.clear();
    console.log(`${colors.red}\x1b[1m🗑️  DELETE CONFIRMATION\x1b[0m${colors.reset}`);
    console.log(`\nYou are about to delete ${toDelete.length} node_modules directories:`);

    toDelete.forEach((module, index) => {
      console.log(
        `${colors.red}  ${index + 1}. ${module.path} (${formatBytes(module.size)})${colors.reset}`,
      );
    });

    const totalSize = toDelete.reduce((sum, module) => sum + module.size, 0);
    console.log(
      `${colors.yellow}\nTotal space to free: ${formatBytes(totalSize)}${colors.reset}`,
    );
    console.log(
      `${colors.yellow}\nPress y to confirm, any other key to cancel...${colors.reset}`,
    );

    const confirmed = await new Promise<boolean>((resolve) => {
      safeSetRawMode(true);
      process.stdin.resume();
      process.stdin.once("data", (data) => {
        const key = data.toString().toLowerCase();
        safeSetRawMode(false);
        process.stdin.pause();
        resolve(key === "y");
      });
    });

    if (!confirmed) {
      console.log(`${colors.yellow}Deletion cancelled.${colors.reset}`);
      process.exit(0);
    }

    console.log(`${colors.blue}\n🗑️  Deleting selected directories...${colors.reset}`);

    const deletion = await deleteModules(toDelete);
    const deletedSet = new Set(deletion.deletedPaths);

    this.nodeModules = this.nodeModules.filter((module) => !deletedSet.has(module.path));
    deletedSet.forEach((path) => this.selectedPaths.delete(path));

    console.log(`${colors.bold}${colors.green}\n🎉 Cleanup complete!${colors.reset}`);
    console.log(`${colors.green}   Deleted: ${deletion.deleted} directories${colors.reset}`);
    console.log(`${colors.green}   Freed: ${formatBytes(deletion.freed)}${colors.reset}`);
    console.log(
      `${colors.green}   Time taken: ${formatElapsedTime(deletion.elapsedMs)}${colors.reset}`,
    );

    if (deletion.failedPaths.length > 0) {
      console.log(
        `${colors.red}   Failed: ${deletion.failedPaths.length} directories${colors.reset}`,
      );
    }

    console.log(
      `${colors.blue}   Remaining: ${this.nodeModules.length} directories (${this.getTotalSize()})${colors.reset}`,
    );

    if (this.nodeModules.length > 0) {
      console.log(`${colors.yellow}\nPress any key to continue...${colors.reset}`);
      await new Promise<void>((resolve) => {
        safeSetRawMode(true);
        process.stdin.resume();
        process.stdin.once("data", () => {
          safeSetRawMode(false);
          process.stdin.pause();
          resolve();
        });
      });
    }

    process.exit(0);
  }

  private async openDirectory(module: NodeModule): Promise<void> {
    const cmd = process.platform === "darwin"
      ? ["open", module.path]
      : process.platform === "win32"
        ? ["explorer", module.path.replaceAll("/", "\\")]
        : ["xdg-open", module.path];

    try {
      const proc = Bun.spawn({
        cmd,
        stdout: "ignore",
        stderr: "ignore",
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        throw new Error(`open command failed with exit code ${exitCode}`);
      }
    } catch (error) {
      console.error(
        `${colors.red}Error opening directory:${colors.reset}`,
        error,
      );
    }
  }

  getTotalSize(): string {
    const total = this.nodeModules.reduce((sum, module) => sum + module.size, 0);
    return formatBytes(total);
  }

  getNodeModules(): NodeModule[] {
    return this.nodeModules;
  }

  formatElapsedTime(ms: number): string {
    return formatElapsedTime(ms);
  }

  private async checkDailyUpdate(): Promise<void> {
    try {
      const updateCheckFile = join(
        process.env.HOME || process.env.USERPROFILE || "/tmp",
        APP_CONFIG.updateCheckFile,
      );
      const now = Date.now();

      let lastCheck = 0;
      try {
        const stats = await stat(updateCheckFile);
        lastCheck = stats.mtime.getTime();
      } catch {
        lastCheck = 0;
      }

      if (now - lastCheck <= APP_CONFIG.updateCheckIntervalMs) {
        return;
      }

      await Bun.write(updateCheckFile, "");
      process.stdout.write(`${colors.gray}Checking for updates...${colors.reset}\n`);

      const latestVersion = await fetchLatestVersion();
      if (!latestVersion || latestVersion === APP_CONFIG.currentVersion) {
        return;
      }

      this.latestVersion = latestVersion;
      this.hasUpdate = true;

      console.log(
        `\n${colors.yellow}╔══════════════════════════════════════════════════════════════╗${colors.reset}`,
      );
      console.log(
        `${colors.yellow}║ 📦 UPDATE AVAILABLE: ${colors.white}${latestVersion}${colors.yellow} (current: ${colors.white}${APP_CONFIG.currentVersion}${colors.yellow}) ║${colors.reset}`,
      );
      console.log(
        `${colors.yellow}║ ${colors.cyan}Run 'bunkill update' to install the latest version${colors.yellow}           ║${colors.reset}`,
      );
      console.log(
        `${colors.yellow}╚══════════════════════════════════════════════════════════════╝${colors.reset}\n`,
      );
    } catch {
      // ignore update check failures
    }
  }
}

program
  .name("bunkill")
  .description("BunKill 🚀 - npkill alternative. Ultra-fast node_modules cleanup tool powered by Bun.js")
  .version(APP_CONFIG.currentVersion)
  .addHelpText(
    "before",
    `${LOGO}
${colors.cyan}BunKill${colors.reset} - npkill alternative
${colors.gray}Ultra-fast node_modules cleanup tool powered by Bun.js${colors.reset}
`,
  )
  .addHelpText(
    "after",
    `
${colors.cyan}EXAMPLES:${colors.reset}
  ${colors.green}bunkill${colors.reset}                    # Interactive cleanup in current directory
  ${colors.green}bunkill --dry-run${colors.reset}          # See what would be deleted
  ${colors.green}bunkill --delete-all${colors.reset}       # Delete all without confirmation
  ${colors.green}bunkill --dir ~/projects${colors.reset}   # Scan specific directory
  ${colors.green}bunkill --full-scan${colors.reset}        # Scan from your home directory
  ${colors.green}bunkill scan${colors.reset}               # Quick scan and display results
  ${colors.green}bunkill update${colors.reset}             # Check for and install updates
  ${colors.green}bunkill update --check-only${colors.reset} # Only check for updates

${colors.cyan}INTERACTIVE MODE:${colors.reset}
  Use arrow keys to navigate, SPACE to select, ENTER to delete
  Press '/' to search, 's' to cycle sort order, 'd' to toggle details

${colors.cyan}SORT MODES:${colors.reset}
  largest first → newest first → oldest first → name → path

${colors.yellow}⚠️  WARNING:${colors.reset} Deleting node_modules is irreversible.
   Always use --dry-run first to verify what will be removed.
`,
  );

program
  .option("-d, --dir <directory>", "Directory to scan", process.cwd())
  .option("-t, --target <name>", "Target directory name", "node_modules")
  .option("-e, --exclude <patterns...>", "Exclude patterns", [])
  .option("--exclude-hidden", "Exclude hidden directories")
  .option("--hide-errors", "Hide permission errors")
  .option("--full-scan", "Scan from your home directory")
  .option("--depth <number>", "Maximum scan depth", String(APP_CONFIG.defaultScanDepth))
  .option("--dry-run", "Show what would be deleted without deleting")
  .option("--delete-all", "Delete all found node_modules without confirmation")
  .action(async (options) => {
    const bunkill = new BunKill();

    try {
      await bunkill.scan({
        dir: resolve(options.dir),
        target: options.target,
        exclude: options.exclude,
        excludeHidden: options.excludeHidden,
        hideErrors: options.hideErrors,
        isFullScan: options.fullScan,
        depth: parseInt(options.depth, 10),
      });

      if (options.deleteAll) {
        const modules = bunkill.getNodeModules();
        console.log(
          `${colors.red}\x1b[1mDeleting all ${modules.length} node_modules...${colors.reset}`,
        );

        const deletion = await deleteModules(modules);
        console.log(
          `${colors.green}\x1b[1m✅ Deleted ${deletion.deleted} node_modules${colors.reset}`,
        );
        console.log(
          `${colors.green}   Time taken: ${bunkill.formatElapsedTime(deletion.elapsedMs)}${colors.reset}`,
        );
      } else if (options.dryRun) {
        console.log(
          `${colors.blue}\x1b[1mDRY RUN - No files will be deleted\x1b[0m${colors.reset}`,
        );
        bunkill.getNodeModules().forEach((module, index) => {
          console.log(`${index + 1}. ${module.path} (${formatBytes(module.size)})`);
        });
        console.log(`${colors.yellow}\nTotal: ${bunkill.getTotalSize()}${colors.reset}`);
      } else {
        await bunkill.interactiveDelete();
      }
    } catch (error) {
      console.error(`${colors.red}Error:${colors.reset}`, error);
      process.exit(1);
    }
  });

program
  .command("scan")
  .description("Quick scan and display results")
  .action(async () => {
    const bunkill = new BunKill();
    await bunkill.scan({
      dir: process.cwd(),
      target: "node_modules",
      exclude: [],
      excludeHidden: true,
      hideErrors: true,
      isFullScan: false,
      depth: APP_CONFIG.quickScanDepth,
    });

    const modules = bunkill.getNodeModules();
    if (modules.length === 0) {
      console.log(`${colors.green}No node_modules found!${colors.reset}`);
      return;
    }

    console.log(`${colors.blue}\n📊 Scan Results:${colors.reset}`);
    console.log(`${colors.cyan}BunKill v${APP_CONFIG.currentVersion}${colors.reset}\n`);
    modules.forEach((module, index) => {
      const active = module.isActive ? `${colors.green}[ACTIVE]${colors.reset}` : "";
      console.log(
        `${index + 1}. ${colors.white}${module.packageName}${colors.reset} ${colors.gray}(${formatBytes(module.size)})${colors.reset} ${active}`,
      );
      console.log(`   ${colors.blue}${module.path}${colors.reset}`);
    });
    console.log(`${colors.yellow}\nTotal space: ${bunkill.getTotalSize()}${colors.reset}`);
  });

program
  .command("update")
  .description("Check for and install updates")
  .option("--check-only", "Only check for updates without installing")
  .action(async (options) => {
    await checkForUpdates(options.checkOnly);
  });

program
  .command("version")
  .description("Display current version")
  .action(() => {
    console.log(
      `${colors.cyan}BunKill${colors.reset} version ${colors.white}${APP_CONFIG.currentVersion}${colors.reset}`,
    );
  });

async function checkForUpdates(checkOnly = false): Promise<void> {
  console.log(`${colors.blue}🔍 Checking for updates...${colors.reset}`);

  try {
    const latestVersion = await fetchLatestVersion();
    if (!latestVersion) {
      throw new Error("Unable to reach npm registry");
    }

    console.log(
      `${colors.cyan}Current version: ${colors.white}${APP_CONFIG.currentVersion}${colors.reset}`,
    );
    console.log(
      `${colors.cyan}Latest version: ${colors.white}${latestVersion}${colors.reset}`,
    );

    if (latestVersion === APP_CONFIG.currentVersion) {
      console.log(
        `${colors.green}✅ You're already running the latest version!${colors.reset}`,
      );
      return;
    }

    if (checkOnly) {
      console.log(
        `${colors.yellow}📦 New version available: ${latestVersion}${colors.reset}`,
      );
      console.log(
        `${colors.gray}Run 'bunkill update' to install the update.${colors.reset}`,
      );
      return;
    }

    console.log(
      `${colors.yellow}📦 Update available: ${APP_CONFIG.currentVersion} → ${latestVersion}${colors.reset}`,
    );

    const isGlobal = process.argv[1]?.includes("global") ||
      process.argv[1]?.includes(".npm-global") ||
      process.argv[1]?.includes(".bun/bin");

    if (!isGlobal) {
      console.log(
        `${colors.yellow}⚠️  Running in development mode or local installation${colors.reset}`,
      );
      console.log(`${colors.gray}To update, please run:${colors.reset}`);
      console.log(
        `${colors.white}  npm install -g ${APP_CONFIG.packageName}@${latestVersion}${colors.reset}`,
      );
      console.log(`${colors.white}  # or${colors.reset}`);
      console.log(
        `${colors.white}  bun install -g ${APP_CONFIG.packageName}@${latestVersion}${colors.reset}`,
      );
      return;
    }

    let packageManager = "npm";
    if (process.argv[0]?.includes("bun")) {
      packageManager = "bun";
    } else if (process.argv[0]?.includes("yarn")) {
      packageManager = "yarn";
    }

    console.log(`${colors.blue}🔄 Updating via package manager...${colors.reset}`);
    console.log(`${colors.gray}Using ${packageManager} to update...${colors.reset}`);

    try {
      const updateProcess = Bun.spawn({
        cmd: [packageManager, "install", "-g", `${APP_CONFIG.packageName}@${latestVersion}`],
        stdout: "inherit",
        stderr: "inherit",
      });

      const exitCode = await updateProcess.exited;
      if (exitCode !== 0) {
        throw new Error(`Update failed with exit code ${exitCode}`);
      }

      console.log(
        `${colors.green}✅ Successfully updated to version ${latestVersion}!${colors.reset}`,
      );
      console.log(
        `${colors.gray}Restart the application to use the new version.${colors.reset}`,
      );
    } catch (error) {
      console.error(
        `${colors.red}❌ Update failed: ${error instanceof Error ? error.message : "Unknown error"}${colors.reset}`,
      );
      console.log(`${colors.yellow}You can try updating manually with:${colors.reset}`);
      console.log(
        `${colors.white}  ${packageManager} install -g ${APP_CONFIG.packageName}@${latestVersion}${colors.reset}`,
      );
    }
  } catch (error) {
    console.error(
      `${colors.red}❌ Failed to check for updates: ${error instanceof Error ? error.message : "Unknown error"}${colors.reset}`,
    );
    console.log(
      `${colors.gray}Please check your internet connection and try again later.${colors.reset}`,
    );
  }
}

export function runCli(argv = process.argv): void {
  program.parse(argv);
}

if (import.meta.main) {
  runCli();
}
