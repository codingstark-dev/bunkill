export const APP_CONFIG = {
  packageName: "bunkill",
  currentVersion: "1.0.4",
  updateCheckFile: ".bunkill-last-update-check",
  updateCheckIntervalMs: 24 * 60 * 60 * 1000,
  updateCheckTimeoutMs: 2500,
  defaultScanDepth: 10,
  quickScanDepth: 5,
  defaultSizeConcurrency: (() => {
    const cpuCount = typeof navigator !== "undefined"
      ? navigator.hardwareConcurrency
      : 8;
    return Math.max(4, Math.min(16, cpuCount || 8));
  })(),
  defaultDeleteConcurrency: 8,
} as const;

export const SCAN_PATHS = {
  systemSkipPatterns: [
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
  ],
  allowCachePatterns: [
    ".bun",
    ".npm",
    ".vscode",
    ".vscode-insiders",
    ".cache",
    ".config",
    ".yarn",
  ],
  skipCacheSubdirs: [
    "/Library/Caches/com.apple",
    "/Library/Caches/CloudKit",
    "/Library/Caches/Google",
    "/Library/Caches/Microsoft",
  ],
  permissionErrorCodes: ["EACCES", "EPERM", "ENOENT"],
} as const;
