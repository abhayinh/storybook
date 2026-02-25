/**
 * PropExtractionManager — multi-project manager for prop extraction.
 *
 * Follows Volar's typescriptProject.ts pattern:
 *
 * - ConfigProjects: Map<tsconfig, PropExtractionProject> — one LS per tsconfig, lazy
 * - FindTSConfig: generic helper that iterates existing projects + follows reference chains
 * - Dispose + recreate on tsconfig change
 * - Inferred project fallback when no tsconfig is found (Volar's getOrCreateInferredProject)
 * - Shared fsFileSnapshots across all projects (Volar's module-level cache in createChecker.ts)
 * - Project reference chain resolution with cycle detection (Volar's getReferencesChains)
 * - No parsedConfigCache — config data is always accessed through projects (Volar pattern)
 *
 * Manages the lifecycle of PropExtractionProject instances and handles tsconfig discovery for
 * monorepo support (different packages get different LS instances with their own compiler
 * options).
 */
import { existsSync, type FSWatcher, watch } from 'fs';
import * as path from 'path';
import type ts from 'typescript';

import { PropExtractionProject } from './PropExtractionProject';

/**
 * Sensible defaults for inferred projects. Numeric enum values are overridden from the actual TS
 * instance in getOrCreateInferredProject().
 */
const DEFAULT_INFERRED_OPTIONS: ts.CompilerOptions = {
  strict: true,
  esModuleInterop: true,
  allowJs: true,
  skipLibCheck: true,
};

export class PropExtractionManager {
  private projects = new Map<string, PropExtractionProject>();
  /** Volar pattern (typescriptProject.ts): one inferred project per workspace (= manager). */
  private inferredProject: PropExtractionProject | undefined;
  /** Volar pattern (searchedDirs): avoid re-scanning directories for tsconfig files. */
  private searchedDirs = new Set<string>();
  private rootTsConfigs = new Set<string>();
  /** Whether file watching is active. False in build mode, true in dev mode. */
  private watching = false;
  /** Directories currently being watched by fs.watch. */
  private watchedDirs = new Set<string>();
  /** Active fs.watch instances — one per watched directory. */
  private watchers: FSWatcher[] = [];
  /** Debounce timers for pending file events. */
  private pendingEvents = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Shared snapshot cache across all projects.
   *
   * Volar pattern (createChecker.ts line 83): module-level fsFileSnapshots shared across all
   * checker instances. In a monorepo where multiple projects reference the same node_modules files
   * (@types/react, etc.), each file is read only once.
   */
  readonly sharedSnapshots = new Map<
    string,
    [number | undefined, ts.IScriptSnapshot | undefined]
  >();

  constructor(private typescript: typeof ts) {}

  /**
   * Get or create a PropExtractionProject for a given component file.
   *
   * Strategy (Volar's findMatchTSConfig pattern):
   *
   * 1. Walk up to find candidate tsconfigs
   * 2. Verify the file is directly included OR reachable via project references
   * 3. Fall back to inferred project if no tsconfig matches
   */
  getProjectForFile(filePath: string): PropExtractionProject {
    const configPath = this.findMatchingTSConfig(filePath);
    if (configPath) {
      // Project is guaranteed to exist: findMatchingTSConfig creates it via getCommandLineForConfig
      return this.projects.get(configPath) ?? this.getOrCreateInferredProject(filePath);
    }
    return this.getOrCreateInferredProject(filePath);
  }

  /**
   * Find a tsconfig that actually includes this file.
   *
   * Volar pattern (typescriptProject.ts lines 101-233):
   *
   * 1. Collect ALL tsconfigs walking up (not just nearest)
   * 2. Prepare closest root project (ensure at least one project exists for findTSConfig)
   * 3. Pass 1: findDirectIncludeTsconfig — check fileNames via getCommandLineForConfig (creates projects)
   * 4. Pass 2: findIndirectReferenceTsconfig — check via hasSourceFile on EXISTING projects only
   */
  private findMatchingTSConfig(filePath: string): string | null {
    // Volar pattern: collect ALL tsconfigs walking up, not just nearest.
    this.collectTSConfigs(filePath);
    if (this.rootTsConfigs.size === 0) {
      return null;
    }

    const normalizedFilePath = filePath.replace(/\\/g, '/');

    // Volar pattern (prepareClosestootCommandLine): eagerly create the project for
    // the closest matching tsconfig BEFORE the passes. This ensures findTSConfig has
    // at least one project to check (it only processes rootTsConfigs with existing
    // projects). Volar: typescriptProject.ts lines 124-138.
    const ancestorConfigs = [...this.rootTsConfigs]
      .filter((config) =>
        isFileInDir(normalizedFilePath, path.dirname(config).replace(/\\/g, '/'))
      )
      .sort((a, b) => sortTSConfigs(filePath, a, b));

    if (ancestorConfigs.length > 0) {
      this.getOrCreateConfiguredProject(ancestorConfigs[0]);
    }

    // Pass 1: findDirectIncludeTsconfig — check parsed fileNames (creates projects via
    // getCommandLineForConfig). Volar: typescriptProject.ts lines 149-158.
    return (
      this.findTSConfig(filePath, (tsconfig) => {
        const commandLine = this.getCommandLineForConfig(tsconfig);
        if (!commandLine) {
          return false;
        }
        const fileNames = new Set(commandLine.fileNames);
        return fileNames.has(normalizedFilePath);
      }) ??
      // Pass 2: findIndirectReferenceTsconfig — check via program.getSourceFile()
      // on EXISTING projects only (never creates new ones).
      // Volar: typescriptProject.ts lines 139-147.
      this.findTSConfig(filePath, (tsconfig) => {
        const project = this.projects.get(tsconfig);
        return !!project && project.hasSourceFile(normalizedFilePath);
      })
    );
  }

  /**
   * Generic tsconfig finder that iterates existing projects and follows reference chains.
   *
   * Volar pattern (typescriptProject.ts lines 160-188): Iterates ALL rootTsConfigs (sorted by
   * proximity), but only processes ones with EXISTING projects. For each, follows the project
   * reference chain via getReferencesChains, and calls the match callback for each tsconfig in
   * the chain.
   *
   * The match callback determines what constitutes a "match":
   * - Pass 1: creates project + checks fileNames (findDirectIncludeTsconfig)
   * - Pass 2: checks existing project's program (findIndirectReferenceTsconfig)
   */
  private findTSConfig(
    filePath: string,
    match: (tsconfig: string) => boolean
  ): string | null {
    const checked = new Set<string>();
    const sorted = [...this.rootTsConfigs].sort((a, b) => sortTSConfigs(filePath, a, b));

    for (const rootTsConfig of sorted) {
      // Volar pattern: only process rootTsConfigs with existing projects
      const project = this.projects.get(rootTsConfig);
      if (!project) {
        continue;
      }

      let chains = this.getReferencesChains(project.getCommandLine(), rootTsConfig, []);
      // Volar pattern: reverse chains for consistency with tsserver behavior
      chains = chains.reverse();

      for (const chain of chains) {
        for (let i = chain.length - 1; i >= 0; i--) {
          const tsconfig = chain[i];
          if (checked.has(tsconfig)) {
            continue;
          }
          checked.add(tsconfig);
          if (match(tsconfig)) {
            return tsconfig;
          }
        }
      }
    }

    return null;
  }

  /**
   * Recursively resolve project reference chains with cycle detection.
   *
   * Volar pattern (typescriptProject.ts lines 189-229): Follows projectReferences, CREATING
   * projects along the chain via getCommandLineForConfig. This is how Volar discovers all
   * tsconfigs reachable through project references — each referenced tsconfig gets its own
   * project, cached for future lookups.
   *
   * Returns an array of chains, where each chain is a path from root to leaf tsconfig.
   */
  private getReferencesChains(
    commandLine: ts.ParsedCommandLine,
    tsConfig: string,
    before: string[]
  ): string[][] {
    if (!commandLine.projectReferences?.length) {
      return [[...before, tsConfig]];
    }

    const chains: string[][] = [];
    for (const ref of commandLine.projectReferences) {
      let refPath = ref.path.replace(/\\/g, '/');

      // Volar fix for #712: resolve directory references to tsconfig.json / jsconfig.json.
      // Project references can point to a directory (e.g. "../core") instead of a file.
      if (this.typescript.sys.directoryExists(refPath)) {
        const tsconfigInDir = path.join(refPath, 'tsconfig.json');
        const jsconfigInDir = path.join(refPath, 'jsconfig.json');
        if (this.typescript.sys.fileExists(tsconfigInDir)) {
          refPath = tsconfigInDir;
        } else if (this.typescript.sys.fileExists(jsconfigInDir)) {
          refPath = jsconfigInDir;
        }
      }

      // Volar pattern: cycle detection via before array
      const beforeIndex = before.indexOf(refPath);
      if (beforeIndex >= 0) {
        chains.push(before.slice(0, Math.max(beforeIndex, 1)));
      } else {
        // Creates a project for the referenced tsconfig (Volar's getCommandLine pattern)
        const refCommandLine = this.getCommandLineForConfig(refPath);
        if (refCommandLine) {
          for (const chain of this.getReferencesChains(refCommandLine, refPath, [
            ...before,
            tsConfig,
          ])) {
            chains.push(chain);
          }
        }
      }
    }

    return chains;
  }

  /**
   * Get the command line for a tsconfig by creating or retrieving its project.
   *
   * Volar pattern (typescriptProject.ts lines 230-233): Config data is always accessed through
   * projects — `getOrCreateConfiguredProject(tsConfig).getCommandLine()`. There is no separate
   * parsedConfigCache; the project IS the cache.
   */
  private getCommandLineForConfig(tsconfig: string): ts.ParsedCommandLine | null {
    const project = this.getOrCreateConfiguredProject(tsconfig);
    return project?.getCommandLine() ?? null;
  }

  /**
   * Collect ALL tsconfig.json and jsconfig.json files walking up from the file's directory.
   *
   * Volar pattern (typescriptProject.ts lines 101-118): Walk up directories, populating
   * rootTsConfigs and searchedDirs. Uses searchedDirs to avoid re-scanning directories that
   * have already been checked.
   */
  private collectTSConfigs(filePath: string): void {
    let dir = path.dirname(filePath);
    while (true) {
      if (this.searchedDirs.has(dir)) {
        break;
      }
      this.searchedDirs.add(dir);
      for (const name of ['tsconfig.json', 'jsconfig.json']) {
        const configPath = path.join(dir, name);
        if (this.typescript.sys.fileExists(configPath)) {
          this.rootTsConfigs.add(configPath);
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }

  /**
   * Volar pattern (typescriptProjectLs.ts parseConfigWorker lines 262-353):
   * Shared config parsing with outDir patch and path normalization.
   */
  private parseCommandLine(configPath: string): ts.ParsedCommandLine {
    const config = this.typescript.readJsonConfigFile(configPath, this.typescript.sys.readFile);
    const parsed = this.typescript.parseJsonSourceFileConfigFileContent(
      config,
      this.typescript.sys,
      path.dirname(configPath),
      {},
      configPath
    );
    // https://github.com/microsoft/TypeScript/issues/30457
    // https://github.com/johnsoncodehk/volar/issues/1786
    parsed.options.outDir = undefined;
    parsed.fileNames = parsed.fileNames.map((f) => f.replace(/\\/g, '/'));
    return parsed;
  }

  /**
   * Volar pattern (typescriptProject.ts lines 236-256): Creates project with injected
   * getCommandLine callback for lazy re-parsing (Checker pattern).
   */
  private getOrCreateConfiguredProject(configPath: string): PropExtractionProject | null {
    const existing = this.projects.get(configPath);
    if (existing) {
      return existing;
    }

    try {
      const reloadCommandLine = () => this.parseCommandLine(configPath);
      const project = new PropExtractionProject(
        this.typescript,
        reloadCommandLine(),
        configPath,
        this.sharedSnapshots,
        reloadCommandLine
      );
      this.projects.set(configPath, project);

      // Auto-watch the project's directory if watching is active.
      // This handles monorepos where project references point to sibling packages
      // outside the initial cwd — each discovered project root gets its own watcher.
      this.watchDirectory(path.dirname(configPath));

      return project;
    } catch {
      return null;
    }
  }

  /**
   * Get or create the inferred project (no tsconfig found).
   *
   * Volar pattern (typescriptProject.ts lines 258-284): ONE inferred project per workspace.
   * All files without a tsconfig share the same compilation context so cross-file imports resolve
   * correctly. Dynamically adds files via tryAddFile.
   */
  private getOrCreateInferredProject(filePath: string): PropExtractionProject {
    if (!this.inferredProject) {
      const parsed: ts.ParsedCommandLine = {
        options: {
          ...DEFAULT_INFERRED_OPTIONS,
          // All enum-valued options from the actual TS instance — no hardcoded numbers.
          // Volar pattern: use runtime enum values, not compile-time constants.
          target: this.typescript.ScriptTarget.Latest,
          module: this.typescript.ModuleKind.ESNext,
          moduleResolution: this.typescript.ModuleResolutionKind.Bundler,
          jsx: this.typescript.JsxEmit.ReactJSX,
        },
        fileNames: [],
        errors: [],
      };

      this.inferredProject = new PropExtractionProject(
        this.typescript,
        parsed,
        undefined, // No config path for inferred projects
        this.sharedSnapshots
      );
    }

    // Volar pattern (typescriptProjectLs.ts line 196-200):
    // Dynamically add the file if not already included.
    this.inferredProject.tryAddFile(filePath);

    return this.inferredProject;
  }

  /**
   * Invalidate all projects for a new extraction cycle.
   *
   * Each project bumps projectVersion + sets shouldCheckRootFiles. On next extraction:
   * 1. getProjectVersion() → checkRootFilesUpdate() → lazy re-parse tsconfig fileNames
   * 2. LS re-syncs → getScriptVersion (mtime) for each file → only recompiles what changed
   */
  invalidate(): void {
    for (const project of this.projects.values()) {
      project.invalidate();
    }
    this.inferredProject?.invalidate();
  }

  /**
   * Broadcast file change to all projects. Each project selectively bumps projectVersion
   * only if the file is in its program (Volar Checker pattern).
   */
  onFileChanged(filePath: string) {
    this.onFilesChanged([{ filePath, type: 'changed' }]);
  }

  /**
   * Broadcast file creation to all projects. Each project sets shouldCheckRootFiles
   * for lazy config re-parse (Volar Checker pattern — no immediate version bump).
   */
  onFileCreated(filePath: string) {
    this.onFilesChanged([{ filePath, type: 'created' }]);
  }

  /**
   * Broadcast file deletion to all projects. Each project only bumps if the file was in
   * its program, then sets shouldCheckRootFiles (Volar Checker pattern).
   */
  onFileDeleted(filePath: string) {
    this.onFilesChanged([{ filePath, type: 'deleted' }]);
  }

  /**
   * Batch broadcast file changes to all projects.
   *
   * Volar Checker pattern (createChecker.ts lines 409-432): Each project processes the full
   * batch with a single getProgram() call, then breaks after the first created/deleted event.
   * More efficient than per-file dispatch when multiple files change simultaneously.
   */
  onFilesChanged(changes: Array<{ filePath: string; type: 'changed' | 'created' | 'deleted' }>) {
    for (const project of this.projects.values()) {
      project.onFilesChanged(changes);
    }
    this.inferredProject?.onFilesChanged(changes);
  }

  /**
   * Notify that a tsconfig has changed.
   *
   * Volar pattern (typescriptProject.ts lines 43-68): Selective handling per change type:
   * - Created: add to rootTsConfigs (will be discovered on next findMatchingTSConfig)
   * - Changed: dispose project (re-created on next access with fresh config)
   * - Deleted: remove from rootTsConfigs + dispose project
   *
   * No clearing of searchedDirs or rootTsConfigs needed (Volar pattern): the file watcher events
   * maintain rootTsConfigs incrementally. The project disposal ensures stale config data is never
   * served — getOrCreateConfiguredProject will re-parse from disk on next access.
   */
  onConfigChanged(configPath: string, type: 'created' | 'changed' | 'deleted' = 'changed') {
    if (type === 'created') {
      this.rootTsConfigs.add(configPath);
    } else if (type === 'deleted') {
      this.rootTsConfigs.delete(configPath);
    }

    // Dispose + remove the affected project (Volar pattern: re-created on next access)
    const project = this.projects.get(configPath);
    if (project) {
      project.dispose();
      this.projects.delete(configPath);
    }
  }

  /**
   * Start watching directories for file changes.
   *
   * VS Code pattern: the IDE watches the filesystem and forwards events to the language service.
   * This is the headless equivalent — we ARE the file watcher, forwarding events to our projects
   * via the existing onFileChanged/Created/Deleted/ConfigChanged methods.
   *
   * Uses Node.js fs.watch with recursive mode (supported on macOS, Windows, and Linux with
   * Node.js 19+). No external dependencies needed.
   *
   * When watching is active, invalidate() is no longer needed — individual file events keep
   * projects in sync incrementally, exactly like Volar in VS Code.
   *
   * Additional directories are automatically watched when new projects are discovered via
   * tsconfig references (monorepo support — sibling packages get their own watchers).
   *
   * No initial directories needed — projects auto-watch their own directories when discovered
   * via getOrCreateConfiguredProject(). TypeScript knows which directories matter.
   */
  startWatching(): void {
    this.stopWatching();
    this.watching = true;
  }

  /**
   * Watch a single directory recursively. Skips if already covered by an existing watcher
   * (same dir or parent dir). Called automatically when new projects are discovered via
   * tsconfig references — ensures monorepo sibling packages are watched too.
   */
  private watchDirectory(dir: string): void {
    if (!this.watching) {
      return;
    }

    const normalized = dir.replace(/\\/g, '/');

    // Skip if this directory (or a parent) is already being watched
    for (const watched of this.watchedDirs) {
      if (normalized === watched || normalized.startsWith(watched + '/')) {
        return;
      }
    }

    this.watchedDirs.add(normalized);

    try {
      const watcher = watch(dir, { recursive: true }, (eventType, filename) => {
        if (!filename) {
          return;
        }
        const filePath = path.resolve(dir, filename).replace(/\\/g, '/');

        // Skip irrelevant paths
        if (filePath.includes('node_modules') || filePath.includes('.git')) {
          return;
        }

        // Debounce per file: fs.watch can fire multiple events for the same change.
        // 50ms window — fast enough for responsiveness, long enough to coalesce duplicates.
        const existing = this.pendingEvents.get(filePath);
        if (existing) {
          clearTimeout(existing);
        }

        this.pendingEvents.set(
          filePath,
          setTimeout(() => {
            this.pendingEvents.delete(filePath);

            if (eventType === 'rename') {
              // 'rename' fires for both creation and deletion — check existence to distinguish
              if (existsSync(filePath)) {
                this.handleFileEvent(filePath, 'created');
              } else {
                this.handleFileEvent(filePath, 'deleted');
              }
            } else {
              // 'change' = content modified
              this.handleFileEvent(filePath, 'changed');
            }
          }, 50)
        );
      });
      this.watchers.push(watcher);
    } catch {
      // Directory might not exist or recursive watching not supported
    }
  }

  /**
   * Stop all active file watchers and clear pending events.
   */
  stopWatching(): void {
    for (const timeout of this.pendingEvents.values()) {
      clearTimeout(timeout);
    }
    this.pendingEvents.clear();
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers.length = 0;
    this.watchedDirs.clear();
    this.watching = false;
  }

  /**
   * Route a file event to the appropriate handler.
   *
   * Tsconfig changes go to onConfigChanged (project lifecycle management).
   * Source file changes go to onFileChanged/Created/Deleted (project version bumps).
   */
  private handleFileEvent(filePath: string, type: 'created' | 'changed' | 'deleted') {
    const basename = path.basename(filePath);
    if (basename === 'tsconfig.json' || basename === 'jsconfig.json') {
      this.onConfigChanged(filePath, type);
      return;
    }

    switch (type) {
      case 'created':
        this.onFileCreated(filePath);
        break;
      case 'changed':
        this.onFileChanged(filePath);
        break;
      case 'deleted':
        this.onFileDeleted(filePath);
        break;
    }
  }

  dispose() {
    this.stopWatching();
    for (const project of this.projects.values()) {
      project.dispose();
    }
    this.inferredProject?.dispose();
    this.projects.clear();
    this.inferredProject = undefined;
    this.sharedSnapshots.clear();
    this.searchedDirs.clear();
    this.rootTsConfigs.clear();
  }
}

/**
 * Sort tsconfig candidates by priority (Volar's sortTSConfigs pattern).
 *
 * Priority order:
 *
 * 1. Prefer configs whose directory contains the file
 * 2. Prefer deeper paths (more specific tsconfig)
 * 3. Prefer tsconfig.json over other config names
 */
function sortTSConfigs(filePath: string, a: string, b: string): number {
  const dirA = path.dirname(a).replace(/\\/g, '/');
  const dirB = path.dirname(b).replace(/\\/g, '/');
  const normalizedFile = filePath.replace(/\\/g, '/');

  const inA = isFileInDir(normalizedFile, dirA);
  const inB = isFileInDir(normalizedFile, dirB);

  if (inA !== inB) {
    return (inB ? 1 : 0) - (inA ? 1 : 0);
  }

  const aLength = a.split('/').length;
  const bLength = b.split('/').length;

  if (aLength === bLength) {
    const aWeight = path.basename(a) === 'tsconfig.json' ? 1 : 0;
    const bWeight = path.basename(b) === 'tsconfig.json' ? 1 : 0;
    return bWeight - aWeight;
  }

  return bLength - aLength;
}

/**
 * Check if a file is inside a directory (Volar's isFileInDir pattern).
 * Uses path.relative to handle edge cases with different separators.
 */
function isFileInDir(filePath: string, dir: string): boolean {
  const relative = path.relative(dir, filePath);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}
