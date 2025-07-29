#!/usr/bin/env bun
import { program } from "commander";
import { readdir, rm, stat } from "fs/promises";
import { basename, join, resolve } from "path";
import { filesize } from "filesize";
import { spawn } from "bun";

const LOGO = `
\x1b[36m +-+-+-+-+-+-+-+\x1b[0m
\x1b[36m |B|u|n|K|i|l|l|\x1b[0m
\x1b[36m +-+-+-+-+-+-+-+\x1b[0m
\x1b[35m        🚀 Created by codingstark.com\x1b[0m
`;

const CURRENT_VERSION = "1.0.2";
const PACKAGE_NAME = "bunkill";

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
};

interface NodeModule {
  path: string;
  size: number;
  lastModified: Date;
  isActive?: boolean;
  packageName?: string;
  packageVersion?: string;
}

interface ScanOptions {
  dir: string;
  target: string;
  exclude: string[];
  excludeHidden: boolean;
  hideErrors: boolean;
  isFullScan: boolean;
  depth?: number;
  maxConcurrency?: number;
}

class BunKill {
  private nodeModules: NodeModule[] = [];
  private selectedIndices: Set<number> = new Set();
  private cursorIndex = 0;
  private showDetails = false;
  private sortBy: "size" | "lastModified" | "path" = "size";
  private latestVersion: string | null = null;
  private hasUpdate = false;
  private lastSearchTime = 0;

  async scan(options: ScanOptions): Promise<NodeModule[]> {
    await this.checkDailyUpdate();

    console.log(
      `${colors.blue}🔍 Scanning for node_modules directories...${colors.reset}`,
    );
    console.log(`${colors.gray}BunKill v${CURRENT_VERSION}${colors.reset}\n`);

    const startTime = performance.now();
    const results: NodeModule[] = [];
    let foundNodeModules = 0;

    const scanDirectories = options.isFullScan
      ? this.getSystemScanDirectories()
      : [options.dir];

    let currentScanPath = "";
    const progressInterval = setInterval(() => {
      const currentFile = currentScanPath
        ? (currentScanPath.length > 50
          ? "..." + currentScanPath.slice(-47)
          : currentScanPath)
        : "scanning...";
      process.stdout.write(
        `\r${colors.cyan}⏳${colors.reset} ${currentFile} | ${foundNodeModules} node_modules found`,
      );
    }, 100);

    const ultraFastScan = async (rootPath: string): Promise<void> => {
      const maxDepth = options.depth || 10;

      try {
        const pattern = `${rootPath}/**/node_modules`;
        const glob = new Bun.Glob(pattern);
        const matches: string[] = [];

        for await (
          const match of glob.scan({
            cwd: rootPath,
            onlyFiles: false,
            followSymlinks: false,
          })
        ) {
          if (match.split("/node_modules").length > 2) continue;

          const depth = match.replace(rootPath, "").split("/").filter((p) =>
            p
          ).length;
          if (depth > maxDepth) continue;

          matches.push(match);
        }

        const batchSize = 50;
        for (let i = 0; i < matches.length; i += batchSize) {
          const batch = matches.slice(i, i + batchSize);

          await Promise.allSettled(
            batch.map(async (nodeModulesPath: string) => {
              if (this.shouldSkipDirectory(nodeModulesPath)) return;

              const projectPath = nodeModulesPath.replace(
                /\/node_modules$/,
                "",
              );

              if (
                options.exclude.some((ex) => nodeModulesPath.includes(ex))
              ) return;
              if (
                options.excludeHidden && basename(projectPath).startsWith(".")
              ) return;

              const module = await this.processNodeModule(
                nodeModulesPath,
                projectPath,
              );
              if (module) {
                results.push(module);
                foundNodeModules++;
              }
            }),
          );
        }
      } catch (error: any) {
        const queue: Array<{ path: string; depth: number }> = [{
          path: rootPath,
          depth: 0,
        }];

        while (queue.length > 0) {
          const batchSize = Math.min(queue.length, 100);
          const batch = queue.splice(0, batchSize);

          await Promise.allSettled(batch.map(async ({ path, depth }) => {
            if (depth > maxDepth) return;

            currentScanPath = path;

            try {
              if (this.shouldSkipDirectory(path)) return;

              const entries = await readdir(path, { withFileTypes: true });
              const subdirs: string[] = [];

              for (const entry of entries) {
                if (!entry.isDirectory()) continue;

                const fullPath = join(path, entry.name);

                if (this.shouldSkipDirectory(fullPath)) continue;
                if (options.exclude.some((ex) => fullPath.includes(ex))) {
                  continue;
                }
                if (options.excludeHidden && entry.name.startsWith(".")) {
                  continue;
                }

                if (entry.name === options.target) {
                  const module = await this.processNodeModule(fullPath, path);
                  if (module) {
                    results.push(module);
                    foundNodeModules++;
                  }
                } else {
                  subdirs.push(fullPath);
                }
              }

              for (const subdir of subdirs) {
                queue.push({ path: subdir, depth: depth + 1 });
              }
            } catch (error: any) {
              if (
                error.code === "EACCES" || error.code === "EPERM" ||
                error.code === "ENOENT"
              ) return;
              if (!options.hideErrors && error.code !== "EISDIR") {
                console.error(
                  `${colors.red}\nError scanning ${path}:${colors.reset}`,
                  error.message,
                );
              }
            }
          }));
        }
      }
    };

    await Promise.allSettled(scanDirectories.map(ultraFastScan));

    clearInterval(progressInterval);

    const endTime = performance.now();
    const elapsedMs = endTime - startTime;
    this.lastSearchTime = elapsedMs;
    const formattedTime = this.formatElapsedTime(elapsedMs);
    console.log(
      `\n${colors.green}\x1b[1m✅\x1b[0m Scan completed in ${formattedTime}${colors.reset}`,
    );
    console.log(
      `${colors.blue}\x1b[1m📊\x1b[0m Found ${foundNodeModules} node_modules directories${colors.reset}`,
    );

    this.nodeModules = results;
    return results;
  }

  private async processNodeModule(
    nodeModulesPath: string,
    projectPath: string,
  ): Promise<NodeModule | null> {
    try {
      const packageJsonPath = join(projectPath, "package.json");
      let packageName = basename(projectPath);
      let packageVersion = "unknown";
      let isActive = false;

      try {
        const packageContent = await Bun.file(packageJsonPath).json();
        packageName = packageContent.name || packageName;
        packageVersion = packageContent.version || "unknown";

        const stats = await Bun.file(packageJsonPath).stat();
        const daysSinceModified = (Date.now() - stats.mtime.getTime()) /
          (1000 * 60 * 60 * 24);
        isActive = daysSinceModified < 30;
      } catch (error) {
        isActive = false;
      }

      const size = await this.getDirectorySize(nodeModulesPath);
      const stats = await stat(nodeModulesPath);

      return {
        path: nodeModulesPath,
        packageName,
        packageVersion,
        size,
        lastModified: stats.mtime,
        isActive,
      };
    } catch {
      return null;
    }
  }

  private async getDirectorySize(dirPath: string): Promise<number> {
    try {
      const result = await Bun.$`du -sk ${dirPath}`.text();
      const match = result.match(/^(\d+)/);
      return match && match[1] ? parseInt(match[1], 10) * 1024 : 0;
    } catch (error) {
      console.error(`Error calculating directory size: ${error}`);

      return this.ultraFastDirectorySize(dirPath);
    }
  }

  private async ultraFastDirectorySize(dirPath: string): Promise<number> {
    let totalSize = 0;

    try {
      const glob = new Bun.Glob(`${dirPath}/**/*`);

      for await (
        const file of glob.scan({
          cwd: dirPath,
          onlyFiles: true,
          followSymlinks: false,
        })
      ) {
        try {
          const stats = await stat(join(dirPath, file));
          totalSize += stats.size;
        } catch (error) {
          return 0;
        }
      }
    } catch (error) {
      return 0;
    }

    return totalSize;
  }

  async interactiveDelete() {
    if (this.nodeModules.length === 0) {
      console.log(
        `${colors.yellow}No node_modules found to delete.${colors.reset}`,
      );
      return;
    }

    console.log(LOGO);
    const versionText = this.hasUpdate
      ? `${colors.yellow}v${CURRENT_VERSION} 📦${colors.reset}`
      : `${colors.cyan}v${CURRENT_VERSION}${colors.reset}`;

    console.log(
      `${colors.bold}${colors.blue}Found ${this.nodeModules.length} node_modules directories${colors.reset}`,
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
      `${colors.gray}Press s to sort, d to toggle details, o to open directory\n${colors.reset}`,
    );

    try {
      if (process.stdin.setRawMode) {
        process.stdin.setRawMode(true);
      }
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
      console.clear();
      console.log(LOGO);
      const searchTime = this.lastSearchTime > 0
        ? this.formatElapsedTime(this.lastSearchTime)
        : "N/A";
      console.log(
        `${colors.bold}${colors.blue}Found ${this.nodeModules.length} node_modules directories${colors.reset} ${colors.gray}(search took ${searchTime})${colors.reset}`,
      );
      console.log(
        `${colors.cyan}BunKill v${CURRENT_VERSION}${colors.reset} | ${colors.gray}Use ↑/↓ to navigate, SPACE to select, ENTER to delete, q to quit${colors.reset}`,
      );
      console.log(
        `${colors.gray}Press a to select all, s to sort, d to toggle details, o to open directory\n${colors.reset}`,
      );

      const sortedModules = this.getSortedModules();
      const visibleRange = 20;
      const startIndex = Math.max(
        0,
        this.cursorIndex - Math.floor(visibleRange / 2),
      );
      const endIndex = Math.min(
        sortedModules.length,
        startIndex + visibleRange,
      );

      for (let i = startIndex; i < endIndex; i++) {
        const module = sortedModules[i];
        const isSelected = this.selectedIndices.has(i);
        const isCursor = i === this.cursorIndex;

        let line = "";

        if (isCursor) line += `${colors.cyan}\x1b[1m>\x1b[0m `;
        else line += "  ";

        if (isSelected) line += `${colors.green}\x1b[1m[✓]\x1b[0m `;
        else line += "[ ] ";

        if (module) {
          const sizeStr = filesize(module.size, { round: 1 });
          const dateStr = module.lastModified.toLocaleDateString();

          if (this.showDetails) {
            line +=
              `${colors.white}${module.packageName}@${module.packageVersion} ${colors.reset}`;
            line += `${colors.gray}(${sizeStr}, ${dateStr}) ${colors.reset}`;
            line += `${colors.blue}${module.path}${colors.reset}`;
          } else {
            line += `${colors.white}${module.packageName} ${colors.reset}`;
            line += `${colors.gray}${sizeStr} ${colors.reset}`;
            line += `${colors.blue}${basename(module.path)}${colors.reset}`;
          }

          if (module.isActive) {
            line += `${colors.green} \x1b[1m[ACTIVE]\x1b[0m${colors.reset}`;
          }
        }

        console.log(line);
      }

      const totalSelectedSize = Array.from(this.selectedIndices)
        .reduce((sum, idx) => sum + (sortedModules[idx]?.size || 0), 0);

      console.log(
        `${colors.yellow}\nSelected: ${this.selectedIndices.size} folders, ${
          filesize(totalSelectedSize)
        }${colors.reset}`,
      );
    };

    const handleKey = (key: string) => {
      const sortedModules = this.getSortedModules();

      switch (key) {
        case "\u0003":
        case "q":
        case "Q":
          process.stdin.setRawMode(false);
          process.stdin.pause();
          console.log(`${colors.green}\nGoodbye! 👋${colors.reset}`);
          process.exit(0);
          break;

        case "\u001b[A":
          this.cursorIndex = Math.max(0, this.cursorIndex - 1);
          break;

        case "\u001b[B":
          this.cursorIndex = Math.min(
            sortedModules.length - 1,
            this.cursorIndex + 1,
          );
          break;

        case " ":
          if (this.selectedIndices.has(this.cursorIndex)) {
            this.selectedIndices.delete(this.cursorIndex);
          } else {
            this.selectedIndices.add(this.cursorIndex);
          }
          break;

        case "\r":
          this.deleteSelected();
          return;

        case "s":
        case "S":
          this.cycleSort();
          break;

        case "d":
        case "D":
          this.showDetails = !this.showDetails;
          break;

        case "o":
        case "O":
          const module = sortedModules[this.cursorIndex];
          if (module) {
            this.openDirectory(module);
          }
          break;

        case "a":
        case "A":
          if (this.selectedIndices.size === sortedModules.length) {
            this.selectedIndices.clear();
          } else {
            for (let i = 0; i < sortedModules.length; i++) {
              this.selectedIndices.add(i);
            }
          }
          break;
      }

      render();
    };

    process.stdin.on("data", handleKey);
    render();
  }

  private getSortedModules(): NodeModule[] {
    const sorted = [...this.nodeModules];

    sorted.sort((a, b) => {
      switch (this.sortBy) {
        case "size":
          return b.size - a.size;
        case "lastModified":
          return b.lastModified.getTime() - a.lastModified.getTime();
        case "path":
          return a.path.localeCompare(b.path);
        default:
          return b.size - a.size;
      }
    });

    return sorted;
  }

  private cycleSort() {
    const sorts: ("size" | "lastModified" | "path")[] = [
      "size",
      "lastModified",
      "path",
    ];
    const currentIndex = sorts.indexOf(this.sortBy);
    this.sortBy = sorts[(currentIndex + 1) % sorts.length] as
      | "size"
      | "lastModified"
      | "path";
  }

  private async deleteSelected() {
    const sortedModules = this.getSortedModules();
    const toDelete = Array.from(this.selectedIndices)
      .map((i) => sortedModules[i])
      .filter((module): module is NodeModule => module !== undefined);

    if (toDelete.length === 0) return;

    console.clear();
    console.log(
      `${colors.red}\x1b[1m🗑️  DELETE CONFIRMATION\x1b[0m${colors.reset}`,
    );
    console.log(
      `\nYou are about to delete ${toDelete.length} node_modules directories:`,
    );

    toDelete.forEach((module, i) => {
      console.log(
        `${colors.red}  ${i + 1}. ${module.path} (${
          filesize(module.size)
        })${colors.reset}`,
      );
    });

    const totalSize = toDelete.reduce((sum, m) => sum + m.size, 0);
    console.log(
      `${colors.yellow}\nTotal space to free: ${
        filesize(totalSize)
      }${colors.reset}`,
    );

    try {
      if (process.stdin.setRawMode) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
    } catch (error) {
    }

    console.log(
      `${colors.yellow}\nPress y to confirm, any other key to cancel...${colors.reset}`,
    );

    const confirm = await new Promise<boolean>((resolve) => {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.once("data", (data) => {
        const key = data.toString().toLowerCase();
        resolve(key === "y");
        process.stdin.setRawMode(false);
        process.stdin.pause();
      });
    });

    if (confirm) {
      console.log(
        `${colors.blue}\n🗑️  Deleting selected directories...${colors.reset}`,
      );

      const deleteStartTime = performance.now();
      let deletedCount = 0;
      let freedSize = 0;

      for (const module of toDelete) {
        if (!module) continue;
        try {
          console.log(
            `${colors.gray}  Deleting ${module.path}...${colors.reset}`,
          );
          await rm(module.path, { recursive: true, force: true });
          deletedCount++;
          freedSize += module.size;
          console.log(
            `${colors.green}  ✓ Deleted ${module.path} (${
              filesize(module.size)
            })${colors.reset}`,
          );
        } catch (error) {
          console.error(
            `${colors.red}  ✗ Failed to delete ${module.path}: ${error}${colors.reset}`,
          );
        }
      }

      this.nodeModules = this.nodeModules.filter((m) => !toDelete.includes(m));
      this.selectedIndices.clear();

      const deleteEndTime = performance.now();
      const deleteElapsedMs = deleteEndTime - deleteStartTime;
      const deleteTime = this.formatElapsedTime(deleteElapsedMs);

      console.log(
        `${colors.bold}${colors.green}\n🎉 Cleanup complete!${colors.reset}`,
      );
      console.log(
        `${colors.green}   Deleted: ${deletedCount} directories${colors.reset}`,
      );
      console.log(
        `${colors.green}   Freed: ${filesize(freedSize)}${colors.reset}`,
      );
      console.log(
        `${colors.green}   Time taken: ${deleteTime}${colors.reset}`,
      );
      console.log(
        `${colors.blue}   Remaining: ${this.nodeModules.length} directories (${this.getTotalSize()})${colors.reset}`,
      );

      if (this.nodeModules.length > 0) {
        console.log(
          `${colors.yellow}\nPress any key to continue...${colors.reset}`,
        );
        await new Promise((resolve) => {
          process.stdin.setRawMode(true);
          process.stdin.resume();
          process.stdin.once("data", () => {
            process.stdin.setRawMode(false);
            process.stdin.pause();
            resolve(undefined);
          });
        });
      }
    } else {
      console.log(`${colors.yellow}Deletion cancelled.${colors.reset}`);
    }

    try {
      if (process.stdin.setRawMode) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
    } catch (error) {
    }
    process.exit(0);
  }

  private async openDirectory(module: NodeModule) {
    try {
      console.log(`${colors.blue}\nOpening ${module.path}...${colors.reset}`);
      await Bun.$`open ${module.path}`.quiet();
    } catch (error) {
      console.error(
        `${colors.red}Error opening directory:${colors.reset}`,
        error,
      );
    }
  }

  private getSystemScanDirectories(): string[] {
    return [require("os").homedir()];
  }

  private shouldSkipDirectory(dirPath: string): boolean {
    const skipPatterns = [
      "/System",
      "/Library/Application Support",
      "/Library/Frameworks",
      "/Applications",
      "/private",
      "/dev",
      "/proc",
      "/sys",
      "/tmp",
      "/var/tmp",
      "/var/log",
      "/usr/bin",
      "/usr/sbin",
      "/usr/lib",
      "/usr/share",
      "/bin",
      "/sbin",
      "/lib",
      "/lib64",
      "/opt/homebrew",
      "/usr/local/bin",
      "/usr/local/sbin",
      ".photolibrary",
      ".photoslibrary",
      ".photoboothlibrary",
      "Photo Booth Library",
      ".app",
      ".framework",
    ];

    const allowCachePatterns = [
      ".bun",
      ".npm",
      ".vscode",
      ".vscode-insiders",
      ".cache",
      ".config",
      ".yarn",
    ];

    const skipCacheSubdirs = [
      "/Library/Caches/com.apple",
      "/Library/Caches/CloudKit",
      "/Library/Caches/Google",
      "/Library/Caches/Microsoft",
    ];

    const isAllowedCache = allowCachePatterns.some((pattern) =>
      dirPath.includes(pattern) &&
      !skipCacheSubdirs.some((skip) => dirPath.includes(skip))
    );

    if (isAllowedCache) {
      return false;
    }

    if (dirPath.includes(".npm/_npx")) {
      return false;
    }

    return skipPatterns.some((pattern) =>
      dirPath.includes(pattern) ||
      dirPath.toLowerCase().includes(pattern.toLowerCase())
    );
  }

  getTotalSize(): string {
    const total = this.nodeModules.reduce(
      (sum: number, m: NodeModule) => sum + m.size,
      0,
    );
    return filesize(total);
  }

  getNodeModules(): NodeModule[] {
    return this.nodeModules;
  }

  formatElapsedTime(ms: number): string {
    if (ms < 1000) {
      return `${ms.toFixed(0)}ms`;
    } else if (ms < 60000) {
      return `${(ms / 1000).toFixed(2)}s`;
    } else {
      const minutes = Math.floor(ms / 60000);
      const seconds = ((ms % 60000) / 1000).toFixed(1);
      return `${minutes}m ${seconds}s`;
    }
  }

  private async checkDailyUpdate() {
    try {
      const updateCheckFile = join(
        process.env.HOME || process.env.USERPROFILE || "/tmp",
        ".bunkill-last-update-check",
      );
      const now = Date.now();
      const oneDay = 24 * 60 * 60 * 1000;

      let lastCheck = 0;
      try {
        const stats = await stat(updateCheckFile);
        lastCheck = stats.mtime.getTime();
      } catch (error) {
        lastCheck = 0;
      }

      if (now - lastCheck > oneDay) {
        await Bun.write(updateCheckFile, "");

        try {
          const response = await fetch(
            `https://registry.npmjs.org/${PACKAGE_NAME}/latest`,
          );
          if (response.ok) {
            const data = await response.json() as { version: string };
            const latestVersion = data.version;

            if (latestVersion !== CURRENT_VERSION) {
              this.latestVersion = latestVersion;
              this.hasUpdate = true;
              console.log(
                `\n${colors.yellow}╔══════════════════════════════════════════════════════════════╗${colors.reset}`,
              );
              console.log(
                `${colors.yellow}║ 📦 UPDATE AVAILABLE: ${colors.white}${latestVersion}${colors.yellow} (current: ${colors.white}${CURRENT_VERSION}${colors.yellow}) ║${colors.reset}`,
              );
              console.log(
                `${colors.yellow}║ ${colors.cyan}Run 'bunkill update' to install the latest version${colors.yellow}           ║${colors.reset}`,
              );
              console.log(
                `${colors.yellow}╚══════════════════════════════════════════════════════════════╝${colors.reset}\n`,
              );
            }
          }
        } catch {
        }
      }
    } catch {
    }
  }
}

program
  .name("bunkill")
  .description("Bun.js-powered node_modules cleanup tool - faster than npkill")
  .version(CURRENT_VERSION)
  .addHelpText(
    "before",
    `${LOGO}
${colors.cyan}BunKill${colors.reset} - The fastest way to clean up node_modules directories
${colors.gray}Powered by Bun.js for maximum performance${colors.reset}
`,
  )
  .addHelpText(
    "after",
    `
${colors.cyan}EXAMPLES:${colors.reset}
  ${colors.green}bunkill${colors.reset}                    # Interactive cleanup in current directory
  ${colors.green}bunkill --dry-run${colors.reset}        # See what would be deleted
  ${colors.green}bunkill --delete-all${colors.reset}     # Delete all without confirmation
  ${colors.green}bunkill --dir ~/projects${colors.reset} # Scan specific directory
  ${colors.green}bunkill --full-scan${colors.reset}      # Scan entire system
  ${colors.green}bunkill scan${colors.reset}             # Quick scan and display results
  ${colors.green}bunkill update${colors.reset}           # Check for and install updates
  ${colors.green}bunkill update --check-only${colors.reset} # Only check for updates

${colors.cyan}INTERACTIVE MODE:${colors.reset}
  Use arrow keys to navigate, SPACE to select, ENTER to delete
  Press 'q' to quit, 'd' to toggle details, 's' to change sort order

${colors.cyan}PERFORMANCE TIPS:${colors.reset}
  • Use --depth to limit scan depth for faster results
  • Use --exclude to skip known large directories
  • Full system scans may take time on large drives

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
  .option("--full-scan", "Perform full system scan")
  .option("--depth <number>", "Maximum scan depth", "10")
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
        depth: parseInt(options.depth),
      });

      if (options.deleteAll) {
        const modules = bunkill.getNodeModules();
        console.log(
          `${colors.red}\x1b[1mDeleting all ${modules.length} node_modules...${colors.reset}`,
        );

        const deleteStartTime = performance.now();
        await Promise.allSettled(
          modules.map((module) =>
            rm(module.path, { recursive: true, force: true })
          ),
        );
        const deleteEndTime = performance.now();
        const deleteElapsedMs = deleteEndTime - deleteStartTime;
        const deleteTime = bunkill.formatElapsedTime(deleteElapsedMs);

        console.log(
          `${colors.green}\x1b[1m✅ Deleted ${modules.length} node_modules${colors.reset}`,
        );
        console.log(
          `${colors.green}   Time taken: ${deleteTime}${colors.reset}`,
        );
      } else if (options.dryRun) {
        console.log(
          `${colors.blue}\x1b[1mDRY RUN - No files will be deleted\x1b[0m${colors.reset}`,
        );
        bunkill.getNodeModules().forEach((module: NodeModule, i: number) => {
          console.log(`${i + 1}. ${module.path} (${filesize(module.size)})`);
        });
        console.log(`${colors.yellow}\nTotal: ${bunkill.getTotalSize()}`);
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
      depth: 5,
    });

    const modules = bunkill.getNodeModules();
    if (modules.length === 0) {
      console.log(`${colors.green}No node_modules found!${colors.reset}`);
      return;
    }

    console.log(`${colors.blue}\n📊 Scan Results:${colors.reset}`);
    console.log(`${colors.cyan}BunKill v${CURRENT_VERSION}${colors.reset}\n`);
    modules.forEach((module, i) => {
      const active = module.isActive
        ? `${colors.green}[ACTIVE]${colors.reset}`
        : "";
      console.log(
        `${
          i + 1
        }. ${colors.white}${module.packageName}${colors.reset} ${colors.gray}(${
          filesize(module.size)
        })${colors.reset} ${active}`,
      );
      console.log(`   ${colors.blue}${module.path}${colors.reset}`);
    });
    console.log(
      `${colors.yellow}\nTotal space: ${bunkill.getTotalSize()}${colors.reset}`,
    );
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
      `${colors.cyan}BunKill${colors.reset} version ${colors.white}${CURRENT_VERSION}${colors.reset}`,
    );
  });

async function checkForUpdates(checkOnly = false) {
  console.log(`${colors.blue}🔍 Checking for updates...${colors.reset}`);

  try {
    const response = await fetch(
      `https://registry.npmjs.org/${PACKAGE_NAME}/latest`,
    );
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json() as { version: string };
    const latestVersion = data.version;

    console.log(
      `${colors.cyan}Current version: ${colors.white}${CURRENT_VERSION}${colors.reset}`,
    );
    console.log(
      `${colors.cyan}Latest version: ${colors.white}${latestVersion}${colors.reset}`,
    );

    if (latestVersion === CURRENT_VERSION) {
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
      `${colors.yellow}📦 Update available: ${CURRENT_VERSION} → ${latestVersion}${colors.reset}`,
    );

    const isGlobal = process.argv[1]?.includes("global") ||
      process.argv[1]?.includes(".npm-global") ||
      process.argv[1]?.includes(".bun/bin");

    if (isGlobal) {
      console.log(
        `${colors.blue}🔄 Updating via package manager...${colors.reset}`,
      );

      let packageManager = "npm";

      if (process.argv[0]?.includes("bun")) {
        packageManager = "bun";
      } else if (process.argv[0]?.includes("yarn")) {
        packageManager = "yarn";
      }

      console.log(
        `${colors.gray}Using ${packageManager} to update...${colors.reset}`,
      );

      try {
        const updateProcess = spawn({
          cmd: [
            packageManager,
            "install",
            "-g",
            `${PACKAGE_NAME}@${latestVersion}`,
          ],
          stdout: "inherit",
          stderr: "inherit",
        });

        const exitCode = await updateProcess.exited;

        if (exitCode === 0) {
          console.log(
            `${colors.green}✅ Successfully updated to version ${latestVersion}!${colors.reset}`,
          );
          console.log(
            `${colors.gray}Restart the application to use the new version.${colors.reset}`,
          );
        } else {
          throw new Error(`Update failed with exit code ${exitCode}`);
        }
      } catch (error) {
        console.error(
          `${colors.red}❌ Update failed: ${
            error instanceof Error ? error.message : "Unknown error"
          }${colors.reset}`,
        );
        console.log(
          `${colors.yellow}You can try updating manually with:${colors.reset}`,
        );
        console.log(
          `${colors.white}  ${packageManager} install -g ${PACKAGE_NAME}@${latestVersion}${colors.reset}`,
        );
      }
    } else {
      console.log(
        `${colors.yellow}⚠️  Running in development mode or local installation${colors.reset}`,
      );
      console.log(`${colors.gray}To update, please run:${colors.reset}`);
      console.log(
        `${colors.white}  npm install -g ${PACKAGE_NAME}@${latestVersion}${colors.reset}`,
      );
      console.log(`${colors.white}  # or${colors.reset}`);
      console.log(
        `${colors.white}  bun install -g ${PACKAGE_NAME}@${latestVersion}${colors.reset}`,
      );
    }
  } catch (error) {
    console.error(
      `${colors.red}❌ Failed to check for updates: ${
        error instanceof Error ? error.message : "Unknown error"
      }${colors.reset}`,
    );
    console.log(
      `${colors.gray}Please check your internet connection and try again later.${colors.reset}`,
    );
  }
}

if (import.meta.main) {
  program.parse();
}
