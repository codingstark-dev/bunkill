export interface NodeModule {
  path: string;
  size: number;
  lastModified: Date;
  isActive?: boolean;
  packageName?: string;
  packageVersion?: string;
  packageManager?: string;
  projectLastModified?: Date;
}

export interface ScanProgress {
  found: number;
  current: string;
  sizedCompleted: number;
  sizedPending: number;
  phase: "discovering" | "sizing" | "complete";
}

export interface ScanOptions {
  dir: string;
  target: string;
  exclude: string[];
  excludeHidden: boolean;
  hideErrors: boolean;
  isFullScan: boolean;
  depth?: number;
  onProgress?: (progress: ScanProgress) => void;
  onModule?: (mod: NodeModule) => void;
  onModuleUpdate?: (path: string, size: number) => void;
}

export interface ScanResult {
  modules: NodeModule[];
  elapsedMs: number;
}

export interface DeleteResult {
  deleted: number;
  freed: number;
  elapsedMs: number;
  failedPaths: string[];
  deletedPaths: string[];
}
