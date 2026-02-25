/**
 * PropExtractionProject — one TS LanguageService per tsconfig.
 *
 * Follows Volar's createChecker.ts patterns:
 *
 * - Selective projectVersion++ (only bump for files in program, Checker pattern)
 * - Lazy checkRootFilesUpdate via shouldCheckRootFiles flag (Checker pattern)
 * - Shared fsFileSnapshots with mtime-based caching (owned by Manager)
 * - TryAddFile for dynamic file inclusion (typescriptProjectLs.ts)
 *
 * Props extraction works probe-free:
 * - Path 1 (primary): Find JSX in story files → getResolvedSignature() → props type
 * - Path 2 (fallback): Direct type inspection for args-only stories (component-meta approach)
 * - extractFromProbe() serializes the resolved props type into ComponentDoc format
 */
import * as path from 'path';
import type ts from 'typescript';

import {
  type ComponentDoc,
  extractFromProbe,
  isReactComponentType,
  resolvePropsFromComponentType,
  resolvePropsFromStoryFile,
} from '../propExtractor';

/** Descriptor for a single component to extract from a story file. */
export interface StoryExtractionEntry {
  storyFilePath: string;
  componentPath: string;
  exportName: string;
  importId?: string;
  memberAccess?: string;
}

export class PropExtractionProject {
  private ls: ts.LanguageService;
  private projectVersion = 0;
  /** Volar Checker pattern (createChecker.ts line 356): lazy flag for config re-parse. */
  private shouldCheckRootFiles = false;
  /**
   * Volar Checker pattern (createChecker.ts line 376-380): cached file names array.
   * Avoids creating a new array on every getScriptFileNames() call.
   * Invalidated when commandLine.fileNames changes.
   */
  private cachedScriptFileNames: string[] | undefined;
  private projectRoot: string;

  constructor(
    private typescript: typeof ts,
    private commandLine: ts.ParsedCommandLine,
    public readonly configPath: string | undefined,
    /**
     * Shared snapshot cache owned by PropExtractionManager.
     * Volar pattern (createChecker.ts line 83): module-level fsFileSnapshots.
     */
    private sharedSnapshots: Map<
      string,
      [number | undefined, ts.IScriptSnapshot | undefined]
    > = new Map(),
    /**
     * Volar Checker pattern (createChecker.ts line 89): injected callback for re-parsing config.
     * Called lazily by checkRootFilesUpdate(). Undefined for inferred projects.
     */
    private reloadCommandLine?: () => ts.ParsedCommandLine
  ) {
    this.projectRoot = configPath
      ? path.dirname(configPath)
      : (commandLine.options.rootDir ?? process.cwd());

    // Volar pattern (createProject.ts): extract getScriptSnapshot and getScriptVersion
    // as standalone functions so readFile and fileExists can reference them.
    const getScriptSnapshot = (fileName: string): ts.IScriptSnapshot | undefined => {
      // Volar pattern: mtime-based snapshot cache (shared across projects)
      const mtime = this.typescript.sys.getModifiedTime?.(fileName)?.valueOf();
      const cached = this.sharedSnapshots.get(fileName);
      if (cached && cached[0] === mtime) {
        return cached[1];
      }

      // Volar pattern (createChecker.ts lines 120-139):
      // Read from disk, cache with mtime, handle missing files
      if (this.typescript.sys.fileExists(fileName)) {
        const content = this.typescript.sys.readFile(fileName);
        const snapshot =
          content !== undefined ? this.typescript.ScriptSnapshot.fromString(content) : undefined;
        this.sharedSnapshots.set(fileName, [mtime, snapshot]);
        return snapshot;
      } else {
        this.sharedSnapshots.set(fileName, [mtime, undefined]);
        return undefined;
      }
    };

    const getScriptVersion = (fileName: string): string => {
      // Volar pattern (createProject.ts line 377-378): mtime for disk files, '' for missing
      if (!this.typescript.sys.fileExists(fileName)) {
        return '';
      }
      return this.typescript.sys.getModifiedTime?.(fileName)?.valueOf().toString() ?? '0';
    };

    // Volar pattern (createProject.ts line 52): spread ts.sys as base, then override.
    const host: ts.LanguageServiceHost = {
      ...this.typescript.sys,
      useCaseSensitiveFileNames: () => this.typescript.sys.useCaseSensitiveFileNames,
      // Volar pattern (createProject.ts line 59-61): explicit getNewLine method.
      getNewLine: () => this.typescript.sys.newLine,

      // Volar Checker pattern: checkRootFilesUpdate() called lazily inside
      // getProjectVersion and getScriptFileNames (createChecker.ts lines 370-382).
      getProjectVersion: () => {
        this.checkRootFilesUpdate();
        return this.projectVersion.toString();
      },
      // Volar Checker pattern (createChecker.ts lines 376-380): cache file names array.
      getScriptFileNames: () => {
        this.checkRootFilesUpdate();
        if (!this.cachedScriptFileNames) {
          this.cachedScriptFileNames = [...this.commandLine.fileNames];
        }
        return this.cachedScriptFileNames;
      },
      // Volar pattern (createProject.ts lines 121-155): explicit getScriptKind.
      getScriptKind: (fileName: string) => {
        switch (path.extname(fileName)) {
          case '.js':
          case '.cjs':
          case '.mjs':
            return this.typescript.ScriptKind.JS;
          case '.jsx':
            return this.typescript.ScriptKind.JSX;
          case '.ts':
          case '.cts':
          case '.mts':
            return this.typescript.ScriptKind.TS;
          case '.tsx':
            return this.typescript.ScriptKind.TSX;
          case '.json':
            return this.typescript.ScriptKind.JSON;
          default:
            return this.typescript.ScriptKind.Unknown;
        }
      },
      getScriptVersion,
      getScriptSnapshot,
      getCompilationSettings: () => this.commandLine.options,
      getCurrentDirectory: () => this.projectRoot,
      getDefaultLibFileName: this.typescript.getDefaultLibFilePath,
      // Volar pattern (createProject.ts line 110-112): fileExists via getScriptVersion
      fileExists: (f) => getScriptVersion(f) !== '',
      // Volar pattern (createProject.ts lines 97-102): readFile via getScriptSnapshot
      readFile: (f) => {
        const snapshot = getScriptSnapshot(f);
        if (snapshot) {
          return snapshot.getText(0, snapshot.getLength());
        }
      },
      getProjectReferences: () => this.commandLine.projectReferences,
    };

    this.ls = this.typescript.createLanguageService(host);
  }

  /**
   * Force the project to re-sync on next access.
   *
   * Sets shouldCheckRootFiles flag (lazy re-parse on next getProjectVersion/getScriptFileNames)
   * and bumps projectVersion (forces LS to re-check getScriptVersion/mtime for all files).
   */
  invalidate(): void {
    this.projectVersion++;
    this.shouldCheckRootFiles = true;
  }

  /**
   * Get the current command line configuration.
   *
   * Volar pattern (typescriptProjectLs.ts line 208): Config data is always accessed through
   * the project — the project IS the cache.
   */
  getCommandLine(): ts.ParsedCommandLine {
    return this.commandLine;
  }

  /**
   * Dynamically add a file to the project's file list.
   *
   * Volar pattern (typescriptProjectLs.ts lines 196-200): Used for inferred projects and files not
   * in tsconfig's include.
   */
  tryAddFile(fileName: string): void {
    if (!this.commandLine.fileNames.includes(fileName)) {
      this.commandLine.fileNames.push(fileName);
      this.cachedScriptFileNames = undefined;
      this.projectVersion++;
    }
  }

  /**
   * Batch-add multiple files to the project in one go.
   * Only bumps projectVersion once, avoiding repeated program rebuilds.
   */
  ensureFiles(fileNames: string[]): void {
    let added = false;
    for (const fileName of fileNames) {
      if (!this.commandLine.fileNames.includes(fileName)) {
        this.commandLine.fileNames.push(fileName);
        added = true;
      }
    }
    if (added) {
      this.cachedScriptFileNames = undefined;
      this.projectVersion++;
    }
  }

  /**
   * Lazy config re-parse, triggered by shouldCheckRootFiles flag.
   *
   * Volar Checker pattern (createChecker.ts lines 436-447): Only re-parses when the flag is set
   * (by created/deleted file events or invalidate()). Only updates fileNames — options changes
   * are handled by project recreation via onConfigChanged in the Manager.
   */
  private checkRootFilesUpdate(): void {
    if (!this.shouldCheckRootFiles) {
      return;
    }
    this.shouldCheckRootFiles = false;
    if (!this.reloadCommandLine) {
      return;
    }
    try {
      const newCommandLine = this.reloadCommandLine();
      if (!arrayItemsEqual(newCommandLine.fileNames, this.commandLine.fileNames)) {
        this.commandLine.fileNames = newCommandLine.fileNames;
        this.cachedScriptFileNames = undefined;
        this.projectVersion++;
      }
    } catch {
      // Config parse failure — keep existing fileNames
    }
  }

  // ---------------------------------------------------------------------------
  // Primary extraction method — probe-free
  // ---------------------------------------------------------------------------

  /**
   * Extract component props from a story file's JSX usage.
   *
   * Path 1 (primary): Finds JSX elements in the story file that match the target component,
   * then extracts the props type via `getResolvedSignature()`.
   *
   * Path 2 (fallback): For args-only stories with no JSX, inspects the component's type
   * directly via `getCallSignatures()[0].parameters[0]` (component-meta approach).
   *
   * @param storyFilePath - Absolute path to the story file
   * @param componentPath - Absolute path to the component's source file
   * @param exportName - The export name of the component (e.g., 'Button', 'default')
   * @param importId - The import specifier as written in the story file (e.g., './Button', '@mantine/core')
   * @param memberAccess - For compound components (e.g., 'Root' in `<Accordion.Root />`)
   */
  extractPropsFromStory(
    storyFilePath: string,
    componentPath: string,
    exportName: string,
    importId?: string,
    memberAccess?: string,
  ): ComponentDoc[] {
    const results = this.extractPropsFromStories([
      { storyFilePath, componentPath, exportName, importId, memberAccess },
    ]);
    return results.get(storyFilePath)?.get(exportName) ?? [];
  }

  /**
   * Batch-extract component props from multiple story files.
   *
   * Gets the program once, resolves all types, then serializes all props — far more
   * efficient than calling extractPropsFromStory() per component.
   *
   * @returns Map of storyFilePath → Map of exportName → ComponentDoc[]
   */
  extractPropsFromStories(
    entries: StoryExtractionEntry[],
  ): Map<string, Map<string, ComponentDoc[]>> {
    const result = new Map<string, Map<string, ComponentDoc[]>>();

    // Batch-add all files first (one projectVersion bump)
    this.ensureFiles(entries.flatMap((e) => [e.storyFilePath, e.componentPath]));

    const program = this.ls.getProgram();
    if (!program) {
      return result;
    }
    const checker = program.getTypeChecker();

    // Group entries by componentPath for batched extractFromProbe calls
    type Resolved = {
      exportName: string;
      propsType: ts.Type;
      componentPath: string;
      componentSourceFile: ts.SourceFile;
      defaultsSourcePath?: string;
    };
    const byComponentPath = new Map<string, Resolved[]>();

    for (const entry of entries) {
      const storySourceFile = program.getSourceFile(entry.storyFilePath);
      if (!storySourceFile) {
        continue;
      }

      // Resolve the component's source file
      const isPackageImport = entry.importId && !entry.importId.startsWith('.');
      let componentSourceFile: ts.SourceFile | undefined;

      if (isPackageImport) {
        const resolved = this.typescript.resolveModuleName(
          entry.importId!, entry.storyFilePath, this.commandLine.options, this.typescript.sys,
        );
        if (resolved.resolvedModule) {
          componentSourceFile = program.getSourceFile(resolved.resolvedModule.resolvedFileName);
        }
      } else {
        componentSourceFile = program.getSourceFile(entry.componentPath);
      }

      if (!componentSourceFile) {
        continue;
      }

      // Path 1: Find JSX in story file
      let propsType: ts.Type | undefined;
      if (entry.importId) {
        propsType = resolvePropsFromStoryFile(
          this.typescript, checker, storySourceFile,
          entry.importId, entry.exportName, entry.memberAccess,
        );
      }

      // Path 2: Fallback — direct type inspection
      if (!propsType) {
        propsType = this.resolveFromComponentExport(
          checker, componentSourceFile, entry.exportName, entry.memberAccess,
        );
      }

      if (!propsType) {
        continue;
      }

      const resolvedFileName = componentSourceFile.fileName;
      const defaultsSourcePath =
        resolvedFileName.endsWith('.d.ts') ||
        resolvedFileName.endsWith('.d.mts') ||
        resolvedFileName.endsWith('.d.cts')
          ? entry.componentPath
          : undefined;

      // Group by component path for batched serialization
      const key = entry.componentPath;
      let group = byComponentPath.get(key);
      if (!group) {
        group = [];
        byComponentPath.set(key, group);
      }
      group.push({
        exportName: entry.exportName,
        propsType,
        componentPath: entry.componentPath,
        componentSourceFile,
        defaultsSourcePath,
      });
    }

    // Batch-serialize: one extractFromProbe call per component path
    for (const [, resolvedEntries] of byComponentPath) {
      const first = resolvedEntries[0];
      const propsTypes = new Map<string, ts.Type>();
      for (const r of resolvedEntries) {
        propsTypes.set(r.exportName, r.propsType);
      }

      const docs = extractFromProbe(
        this.typescript,
        checker,
        first.componentPath,
        first.componentSourceFile,
        propsTypes,
        first.defaultsSourcePath,
      );

      // Map docs back to their entry keys
      for (const doc of docs) {
        for (const entry of entries) {
          if (
            entry.componentPath === first.componentPath &&
            entry.exportName === doc.exportName
          ) {
            let storyMap = result.get(entry.storyFilePath);
            if (!storyMap) {
              storyMap = new Map();
              result.set(entry.storyFilePath, storyMap);
            }
            storyMap.set(entry.exportName, [doc]);
          }
        }
      }
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Convenience methods (used by tests and simple extraction)
  // ---------------------------------------------------------------------------

  /**
   * Extract component docs from a single file by scanning all its exports.
   *
   * Uses direct type inspection (Path 2) for each exported component.
   * No story file or JSX needed — useful for tests and standalone extraction.
   *
   * Unlike the production path (`extractPropsFromStory`), this method must detect
   * which exports are React components without JSX context. It uses `isReactComponentType`
   * to filter non-component exports (utility functions, hooks, namespaces, etc.).
   */
  extractDocs(filePath: string): ComponentDoc[] {
    this.tryAddFile(filePath);

    const program = this.ls.getProgram();
    if (!program) {
      return [];
    }
    const checker = program.getTypeChecker();
    const sourceFile = program.getSourceFile(filePath);
    if (!sourceFile) {
      return [];
    }

    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) {
      return [];
    }

    const exports = checker.getExportsOfModule(moduleSymbol);
    const propsTypes = new Map<string, ts.Type>();

    for (const exp of exports) {
      const name = exp.getName();
      if (name !== 'default' && !/^[A-Z]/.test(name)) {
        continue;
      }

      // Use getTypeOfSymbol directly — this correctly handles:
      // - Class exports (returns constructor type with construct signatures)
      // - Inline default exports (e.g., `export default (props) => ...`)
      // - Type-asserted exports (e.g., `export default X as Y`)
      const componentType = checker.getTypeOfSymbol(exp);

      // Validate this is actually a React component, not a utility function
      if (!isReactComponentType(this.typescript, checker, componentType)) {
        continue;
      }

      const propsType = resolvePropsFromComponentType(this.typescript, checker, componentType);
      if (propsType) {
        propsTypes.set(name, propsType);
      }
    }

    return extractFromProbe(this.typescript, checker, filePath, sourceFile, propsTypes);
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolve props type from a component's module export using direct type inspection.
   *
   * Gets the export by name, resolves its type, and extracts props via
   * resolvePropsFromComponentType (call signatures / construct signatures).
   */
  private resolveFromComponentExport(
    checker: ts.TypeChecker,
    componentSourceFile: ts.SourceFile,
    exportName: string,
    memberAccess?: string,
  ): ts.Type | undefined {
    const moduleSymbol = checker.getSymbolAtLocation(componentSourceFile);
    if (!moduleSymbol) {
      return undefined;
    }

    const exports = checker.getExportsOfModule(moduleSymbol);
    const targetExport = exports.find((e) => e.getName() === exportName);
    if (!targetExport) {
      return undefined;
    }

    const resolved =
      targetExport.flags & this.typescript.SymbolFlags.Alias
        ? checker.getAliasedSymbol(targetExport)
        : targetExport;
    // Skip type-only exports (interfaces, type aliases) — they can't be components
    if (!resolved.valueDeclaration && !resolved.declarations?.length) {
      return undefined;
    }

    // Use getTypeOfSymbol (not getTypeAtLocation) — for class components this returns
    // the constructor type with construct signatures, which resolvePropsFromComponentType needs.
    let componentType = checker.getTypeOfSymbol(resolved);

    // Handle compound components (e.g., Accordion.Root)
    if (memberAccess) {
      const prop = componentType.getProperty(memberAccess);
      if (prop) {
        componentType = checker.getTypeOfSymbol(prop);
      } else {
        return undefined;
      }
    }

    return resolvePropsFromComponentType(this.typescript, checker, componentType);
  }

  // ---------------------------------------------------------------------------
  // Project management (unchanged from Volar patterns)
  // ---------------------------------------------------------------------------

  /**
   * Check if a file is in this project's TypeScript program.
   *
   * Volar's findIndirectReferenceTsconfig pattern: Uses program.getSourceFile() to check for
   * transitively included files (imported but not necessarily in the tsconfig's include list).
   */
  hasSourceFile(filePath: string): boolean {
    return !!this.ls.getProgram()?.getSourceFile(filePath);
  }

  /**
   * Notify that a file has changed on disk.
   *
   * Delegates to onFilesChanged for single-file convenience.
   */
  onFileChanged(filePath: string, type: 'changed' | 'created' | 'deleted' = 'changed'): void {
    this.onFilesChanged([{ filePath, type }]);
  }

  /**
   * Batch notify file changes on disk.
   *
   * Volar LS pattern (typescriptProjectLs.ts lines 98-104): Process ALL changes in the batch,
   * then bump projectVersion ONCE. No early break — all events contribute to the final state.
   *
   * - Changed: invalidate snapshot cache, mark for version bump if file is in program
   * - Created: invalidate snapshot cache, flag for lazy config re-parse
   * - Deleted: invalidate snapshot cache, flag for lazy config re-parse, mark for version bump
   *
   * Snapshot cache is explicitly invalidated on event (Volar fileSystem.ts pattern) rather
   * than relying solely on mtime-on-access, which can miss same-second edits.
   */
  onFilesChanged(changes: Array<{ filePath: string; type: 'changed' | 'created' | 'deleted' }>): void {
    const program = this.ls.getProgram();
    let needsVersionBump = false;

    for (const { filePath, type } of changes) {
      // Volar fileSystem.ts pattern: explicitly invalidate snapshot cache on event.
      // Ensures stale data is never served, even on filesystems with 1s mtime granularity.
      this.sharedSnapshots.delete(filePath);

      if (type === 'changed') {
        if (program?.getSourceFile(filePath)) {
          needsVersionBump = true;
        }
      } else if (type === 'deleted') {
        if (program?.getSourceFile(filePath)) {
          needsVersionBump = true;
        }
        this.shouldCheckRootFiles = true;
      } else if (type === 'created') {
        this.shouldCheckRootFiles = true;
      }
    }

    // Volar LS pattern: bump projectVersion ONCE per batch, not per file.
    if (needsVersionBump || this.shouldCheckRootFiles) {
      this.projectVersion++;
    }
  }

  dispose() {
    this.ls.dispose();
    // Note: sharedSnapshots is NOT cleared here — it's owned by the Manager
  }
}

/**
 * Volar Checker pattern (createChecker.ts lines 450-461): set-based array equality check.
 */
function arrayItemsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const set = new Set(a);
  for (const file of b) {
    if (!set.has(file)) {
      return false;
    }
  }
  return true;
}
