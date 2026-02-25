/**
 * PropExtractionProject — one TS LanguageService per tsconfig.
 *
 * Follows Volar's createChecker.ts patterns:
 *
 * - LanguageServiceHost with virtual probe files
 * - Selective projectVersion++ (only bump for files in program, Checker pattern)
 * - Lazy checkRootFilesUpdate via shouldCheckRootFiles flag (Checker pattern)
 * - Shared fsFileSnapshots with mtime-based caching (owned by Manager)
 * - TryAddFile for dynamic file inclusion (typescriptProjectLs.ts)
 *
 * The probe files are virtual TypeScript files that import from target component files and use
 * React's ComponentProps<typeof X> to extract props. Separate probeVersion/probeVersionPkg counters
 * ensure probe recompilation is decoupled from disk file changes.
 */
import * as path from 'path';
import type ts from 'typescript';

import { type ComponentDoc, extractFromProbe, resolveProbeTypes } from '../propExtractor';

export class PropExtractionProject {
  private ls: ts.LanguageService;
  private projectVersion = 0;
  /** Volar Checker pattern: separate version counters for probe files. */
  private probeVersion = 0;
  private probeVersionPkg = 0;
  /** Volar Checker pattern (createChecker.ts line 356): lazy flag for config re-parse. */
  private shouldCheckRootFiles = false;
  private probeContent = '';
  /** Separate probe state for package imports — avoids clobbering with local probe. */
  private probeContentPkg = '';
  /**
   * Volar Checker pattern (createChecker.ts line 376-380): cached file names array.
   * Avoids creating a new array on every getScriptFileNames() call.
   * Invalidated when commandLine.fileNames or probe files change.
   */
  private cachedScriptFileNames: string[] | undefined;
  readonly probeFilePath: string;
  /** Separate virtual file for package-import probes. */
  readonly probeFilePathPkg: string;

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
    const projectRoot = configPath
      ? path.dirname(configPath)
      : (commandLine.options.rootDir ?? process.cwd());
    // .tsx extension required for JSX elements in the probe
    this.probeFilePath = path.join(projectRoot, '__probe__.tsx');
    this.probeFilePathPkg = path.join(projectRoot, '__probe_pkg__.tsx');
    // Volar pattern (createProject.ts): extract getScriptSnapshot and getScriptVersion
    // as standalone functions so readFile and fileExists can reference them.
    const getScriptSnapshot = (fileName: string): ts.IScriptSnapshot | undefined => {
      if (fileName === this.probeFilePath) {
        return this.typescript.ScriptSnapshot.fromString(this.probeContent);
      }
      if (fileName === this.probeFilePathPkg) {
        return this.typescript.ScriptSnapshot.fromString(this.probeContentPkg);
      }
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
      if (fileName === this.probeFilePath) {
        return this.probeVersion.toString();
      }
      if (fileName === this.probeFilePathPkg) {
        return this.probeVersionPkg.toString();
      }
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
          this.cachedScriptFileNames = [
            ...this.commandLine.fileNames,
            this.probeFilePath,
            this.probeFilePathPkg,
          ];
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
      getCurrentDirectory: () => projectRoot,
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

  /**
   * Extract component documentation from a single file. Delegates to extractDocsBulk with a
   * single-element array.
   */
  extractDocs(filePath: string): ComponentDoc[] {
    return this.extractDocsBulk([filePath]).get(filePath) ?? [];
  }

  /**
   * Bulk-extract component docs for multiple files in one pass.
   *
   * Volar pattern: one probe + one getProgram() call for ALL files. This avoids N LS re-syncs (each
   * checking getScriptVersion for every project file). Instead: one sync, one type-check, extract
   * all.
   *
   * Invalidation follows Volar's model: projectVersion is bumped once per cycle (via
   * getProjectVersion → checkRootFilesUpdate). The LS detects mtime changes in getScriptVersion and
   * recompiles only what changed. No application-level mtime scanning needed — the LS handles it.
   */
  /** Debug timings from the last extractDocsBulk call. */
  lastBulkDebug: Record<string, unknown> = {};

  extractDocsBulk(filePaths: string[]): Map<string, ComponentDoc[]> {
    const debug: Record<string, unknown> = {};
    const results = new Map<string, ComponentDoc[]>();

    // Collect candidates for all files
    const tCandidates = performance.now();
    const fileEntries: Array<{
      filePath: string;
      relativePath: string;
      candidates: Array<{ exportName: string; isDefault: boolean }>;
    }> = [];

    for (const filePath of filePaths) {
      const candidates = this.getCandidatesFromSource(filePath);
      if (candidates.length === 0) {
        results.set(filePath, []);
        continue;
      }

      const probeDir = path.dirname(this.probeFilePath);
      let relativePath = path.relative(probeDir, filePath);
      relativePath = relativePath.replace(/\.(tsx?|jsx?)$/, '');
      if (!relativePath.startsWith('.')) {
        relativePath = './' + relativePath;
      }
      relativePath = relativePath.replace(/\\/g, '/');

      fileEntries.push({ filePath, relativePath, candidates });
    }
    debug.candidatesMs = Math.round(performance.now() - tCandidates);
    debug.fileEntries = fileEntries.length;
    debug.totalCandidates = fileEntries.reduce((s, e) => s + e.candidates.length, 0);

    if (fileEntries.length === 0) {
      this.lastBulkDebug = debug;
      return results;
    }

    // Build ONE mega-probe importing from all files.
    const tProbe = performance.now();
    const { source, perFileVarMaps, perFileDetMaps } = this.generateBulkProbeSource(fileEntries);
    debug.probeGenMs = Math.round(performance.now() - tProbe);
    debug.probeLines = source.split('\n').length;

    // Only update probe if content actually changed — stable probe means the
    // LS skips recompilation entirely (projectVersion unchanged → same getScriptVersion).
    const probeChanged = source !== this.probeContent;
    debug.probeChanged = probeChanged;
    if (probeChanged) {
      this.probeContent = source;
      this.probeVersion++;
      this.projectVersion++;
    }

    // No application-level cache — Volar pattern: the LS handles all caching
    // internally. invalidate() bumps projectVersion → LS re-syncs → checks
    // getScriptVersion (mtime) for each file → only recompiles what changed.
    // If nothing changed, getProgram() returns the cached Program instantly.
    const tProgram = performance.now();
    const program = this.ls.getProgram();
    debug.getProgramMs = Math.round(performance.now() - tProgram);
    if (!program) {
      this.lastBulkDebug = debug;
      return results;
    }

    const tResolve = performance.now();
    const checker = program.getTypeChecker();
    const probeSF = program.getSourceFile(this.probeFilePath);
    if (!probeSF) {
      this.lastBulkDebug = debug;
      return results;
    }

    // Resolve props from probe: conditional types filter non-components,
    // JSX elements extract concrete props via getResolvedSignature.
    for (const entry of fileEntries) {
      const varMap = perFileVarMaps.get(entry.filePath)!;
      const detMap = perFileDetMaps.get(entry.filePath);
      const propsTypes = resolveProbeTypes(this.typescript, checker, probeSF, varMap, detMap);

      const sourceFile = program.getSourceFile(entry.filePath);
      if (!sourceFile) {
        results.set(entry.filePath, []);
        continue;
      }

      const docs = extractFromProbe(
        this.typescript,
        checker,
        entry.filePath,
        sourceFile,
        propsTypes
      );

      results.set(entry.filePath, docs);
    }
    debug.resolveAndExtractMs = Math.round(performance.now() - tResolve);

    this.lastBulkDebug = debug;
    return results;
  }

  /**
   * Generate a single probe source that imports from ALL files. Uses file index prefix to avoid
   * name collisions.
   *
   * Hybrid approach per candidate:
   *
   * 1. Conditional type for detection (JSXElementConstructor check)
   * 2. JSX element for props extraction (getResolvedSignature)
   */
  private generateBulkProbeSource(
    fileEntries: Array<{
      filePath: string;
      relativePath: string;
      candidates: Array<{ exportName: string; isDefault: boolean }>;
    }>
  ): {
    source: string;
    perFileVarMaps: Map<string, Map<string, string>>;
    perFileDetMaps: Map<string, Map<string, string>>;
  } {
    const lines: string[] = [];
    lines.push(`import { JSXElementConstructor } from 'react';`);
    const perFileVarMaps = new Map<string, Map<string, string>>();
    const perFileDetMaps = new Map<string, Map<string, string>>();

    for (let i = 0; i < fileEntries.length; i++) {
      const { filePath, relativePath, candidates } = fileEntries[i];
      const prefix = `_f${i}_`;
      const varMap = new Map<string, string>();
      const detMap = new Map<string, string>();

      const hasDefault = candidates.some((c) => c.isDefault);
      const named = candidates.filter((c) => !c.isDefault);

      // Build import with prefixed names to avoid collisions
      const parts: string[] = [];
      if (hasDefault) {
        parts.push(`${prefix}Default`);
      }
      if (named.length > 0) {
        parts.push(
          `{ ${named.map((c) => `${c.exportName} as ${prefix}${c.exportName}`).join(', ')} }`
        );
      }

      if (parts.length > 0) {
        lines.push(`import ${parts.join(', ')} from '${relativePath}';`);
      }

      // Detection types + JSX elements
      if (hasDefault) {
        const detName = `${prefix}det_default`;
        const varName = `${prefix}el_default`;
        lines.push(
          `export type ${detName} = typeof ${prefix}Default extends JSXElementConstructor<any> ? true : never;`
        );
        lines.push(`export const ${varName} = <${prefix}Default />;`);
        detMap.set('default', detName);
        varMap.set('default', varName);
      }
      for (const c of named) {
        const detName = `${prefix}det_${c.exportName}`;
        const varName = `${prefix}el_${c.exportName}`;
        lines.push(
          `export type ${detName} = typeof ${prefix}${c.exportName} extends JSXElementConstructor<any> ? true : never;`
        );
        lines.push(`export const ${varName} = <${prefix}${c.exportName} />;`);
        detMap.set(c.exportName, detName);
        varMap.set(c.exportName, varName);
      }

      perFileVarMaps.set(filePath, varMap);
      perFileDetMaps.set(filePath, detMap);
    }

    return { source: lines.join('\n'), perFileVarMaps, perFileDetMaps };
  }

  /**
   * Get export candidates from a source file.
   *
   * First tries lightweight AST-only detection (no checker needed). Falls back to checker-based
   * detection when the file contains `export *` re-exports (barrel files) — these can't be resolved
   * without TypeScript's module resolution.
   */
  private getCandidatesFromSource(
    filePath: string
  ): Array<{ exportName: string; isDefault: boolean }> {
    const content = this.typescript.sys.readFile(filePath);
    if (!content) {
      return [];
    }

    const sf = this.typescript.createSourceFile(
      filePath,
      content,
      this.typescript.ScriptTarget.Latest,
      true
    );

    const candidates: Array<{ exportName: string; isDefault: boolean }> = [];
    let hasStarExport = false;

    for (const stmt of sf.statements) {
      // export const Foo = ..., export function Foo, export class Foo, export interface Foo
      if (this.typescript.isExportAssignment(stmt)) {
        // export default ...
        candidates.push({ exportName: 'default', isDefault: true });
      } else if (hasExportModifier(this.typescript, stmt)) {
        if (hasDefaultModifier(this.typescript, stmt)) {
          candidates.push({ exportName: 'default', isDefault: true });
        } else {
          const name = getDeclarationName(this.typescript, stmt);
          if (name && /^[A-Z]/.test(name)) {
            candidates.push({ exportName: name, isDefault: false });
          }
        }
      } else if (this.typescript.isExportDeclaration(stmt)) {
        if (stmt.exportClause && this.typescript.isNamedExports(stmt.exportClause)) {
          // export { Foo, Bar } or export { default } from ...
          for (const spec of stmt.exportClause.elements) {
            const name = spec.name.text;
            if (name === 'default') {
              candidates.push({ exportName: 'default', isDefault: true });
            } else if (/^[A-Z]/.test(name)) {
              candidates.push({ exportName: name, isDefault: false });
            }
          }
        } else if (!stmt.exportClause) {
          // export * from '...' — barrel file, can't resolve without checker
          hasStarExport = true;
        }
      }
    }

    // For barrel files with `export *`, fall back to checker-based detection.
    // This uses the LS program's checker.getExportsOfModule() which correctly
    // resolves all re-exported symbols through the module graph.
    if (hasStarExport) {
      return this.getCandidatesFromChecker(filePath);
    }

    return candidates;
  }

  /**
   * Checker-based candidate extraction — fallback for barrel files.
   *
   * Uses checker.getExportsOfModule() to resolve `export *` re-exports. More expensive than
   * AST-only detection but handles all export patterns.
   */
  private getCandidatesFromChecker(
    filePath: string
  ): Array<{ exportName: string; isDefault: boolean }> {
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
    return exports
      .filter((exp) => {
        const name = exp.getName();
        if (name !== 'default' && !/^[A-Z]/.test(name)) {
          return false;
        }
        const resolved =
          exp.flags & this.typescript.SymbolFlags.Alias ? checker.getAliasedSymbol(exp) : exp;
        return !!resolved.valueDeclaration;
      })
      .map((exp) => ({
        exportName: exp.getName(),
        isDefault: exp.getName() === 'default',
      }));
  }

  /**
   * Extract a single component's props by import specifier.
   *
   * Used for package imports (e.g. 'flowbite-react') where the resolved file may be compiled JS.
   * The probe imports directly from the specifier, letting TypeScript resolve via tsconfig paths or
   * node_modules .d.ts files.
   */
  extractDocByImport(importSpecifier: string, exportName: string): ComponentDoc | undefined {
    const results = this.extractDocsByImportBulk([{ importSpecifier, exportName }]);
    return results.get(`${importSpecifier}::${exportName}`);
  }

  /**
   * Bulk-extract component docs for multiple package imports in one probe.
   *
   * Groups all exports by import specifier, builds ONE mega-probe, and calls getProgram() once.
   * Same pattern as extractDocsBulk but for package imports instead of local files.
   */
  extractDocsByImportBulk(
    entries: Array<{
      importSpecifier: string;
      exportName: string;
      memberAccess?: string;
      componentPath?: string;
    }>
  ): Map<string, ComponentDoc> {
    const results = new Map<string, ComponentDoc>();
    if (entries.length === 0) {
      return results;
    }

    // Group by specifier for combined imports, preserving memberAccess
    const bySpecifier = new Map<
      string,
      Array<{ exportName: string; isDefault: boolean; memberAccess?: string }>
    >();
    for (const { importSpecifier, exportName, memberAccess } of entries) {
      let group = bySpecifier.get(importSpecifier);
      if (!group) {
        group = [];
        bySpecifier.set(importSpecifier, group);
      }
      group.push({ exportName, isDefault: exportName === 'default', memberAccess });
    }

    // Build ONE mega-probe for all specifiers using hybrid approach:
    // conditional types for detection + JSX elements for props extraction.
    //
    // When memberAccess is set (derived from the outermost JSX component,
    // e.g. `<Accordion.Root>` → memberAccess="Root"), probe the member
    // directly: `<Accordion.Root />`. Otherwise probe the import itself:
    // `<Button />`. resolveCompoundTypes is a last-resort fallback.
    const lines: string[] = [];
    lines.push(`import { JSXElementConstructor } from 'react';`);
    const varNameMap = new Map<string, string>();
    const detTypeMap = new Map<string, string>();

    let idx = 0;
    for (const [specifier, candidates] of bySpecifier) {
      const prefix = `_p${idx}_`;
      const hasDefault = candidates.some((c) => c.isDefault);
      const named = candidates.filter((c) => !c.isDefault);

      const parts: string[] = [];
      if (hasDefault) {
        parts.push(`${prefix}Default`);
      }
      if (named.length > 0) {
        parts.push(
          `{ ${named.map((c) => `${c.exportName} as ${prefix}${c.exportName}`).join(', ')} }`
        );
      }

      if (parts.length > 0) {
        lines.push(`import ${parts.join(', ')} from '${specifier}';`);
      }

      // Generate probe for each candidate.
      // When memberAccess is set (outermost JSX was e.g. <Accordion.Root>),
      // probe the member directly. Otherwise probe the import itself.
      if (hasDefault) {
        const defaultCandidate = candidates.find((c) => c.isDefault)!;
        const ma = defaultCandidate.memberAccess;
        const typeofExpr = ma ? `typeof ${prefix}Default.${ma}` : `typeof ${prefix}Default`;
        const jsxTag = ma ? `${prefix}Default.${ma}` : `${prefix}Default`;
        const detName = `${prefix}det_default`;
        const varName = `${prefix}el_default`;
        lines.push(
          `export type ${detName} = ${typeofExpr} extends JSXElementConstructor<any> ? true : never;`
        );
        lines.push(`export const ${varName} = <${jsxTag} />;`);
        detTypeMap.set(`${specifier}::default`, detName);
        varNameMap.set(`${specifier}::default`, varName);
      }
      for (const c of named) {
        const mapKey = `${specifier}::${c.exportName}`;
        const typeofExpr = c.memberAccess
          ? `typeof ${prefix}${c.exportName}.${c.memberAccess}`
          : `typeof ${prefix}${c.exportName}`;
        const jsxTag = c.memberAccess
          ? `${prefix}${c.exportName}.${c.memberAccess}`
          : `${prefix}${c.exportName}`;
        const detName = `${prefix}det_${c.exportName}`;
        const varName = `${prefix}el_${c.exportName}`;
        lines.push(
          `export type ${detName} = ${typeofExpr} extends JSXElementConstructor<any> ? true : never;`
        );
        lines.push(`export const ${varName} = <${jsxTag} />;`);
        detTypeMap.set(mapKey, detName);
        varNameMap.set(mapKey, varName);
      }
      idx++;
    }

    const source = lines.join('\n');
    if (source !== this.probeContentPkg) {
      this.probeContentPkg = source;
      this.probeVersionPkg++;
      this.projectVersion++;
    }

    const program = this.ls.getProgram();
    if (!program) {
      return results;
    }

    const checker = program.getTypeChecker();
    const probeSF = program.getSourceFile(this.probeFilePathPkg);
    if (!probeSF) {
      return results;
    }

    // Resolve props: conditional types filter non-components, JSX extracts props.
    const allPropsTypes = resolveProbeTypes(
      this.typescript,
      checker,
      probeSF,
      varNameMap,
      detTypeMap
    );

    // Fallback: for entries where the probe failed (e.g. no memberAccess was provided
    // and the import is a namespace), inspect the type's properties to find component-like
    // ones (prefers "Root", then first with call signature).
    this.resolveCompoundTypes(checker, probeSF, entries, varNameMap, allPropsTypes);

    // Build lookup: mapKey → componentPath (source .tsx path from Storybook's resolver)
    const componentPaths = new Map<string, string>();
    for (const { importSpecifier, exportName, componentPath } of entries) {
      if (componentPath) {
        componentPaths.set(`${importSpecifier}::${exportName}`, componentPath);
      }
    }

    // Extract docs for each entry using the resolved props types
    for (const { importSpecifier, exportName } of entries) {
      const mapKey = `${importSpecifier}::${exportName}`;
      const propsType = allPropsTypes.get(mapKey);
      if (!propsType) {
        continue;
      }

      // Resolve import to find the actual source file
      const resolved = this.typescript.resolveModuleName(
        importSpecifier,
        this.probeFilePathPkg,
        this.commandLine.options,
        this.typescript.sys
      );
      const resolvedFileName = resolved.resolvedModule?.resolvedFileName;
      if (!resolvedFileName) {
        continue;
      }

      const sourceFile = program.getSourceFile(resolvedFileName);
      if (!sourceFile) {
        continue;
      }

      // When TypeScript resolves to a .d.ts file (e.g. package imports in monorepos),
      // pass the original source path so extractFromProbe can extract defaults from it.
      const defaultsSourcePath =
        resolvedFileName.endsWith('.d.ts') ||
        resolvedFileName.endsWith('.d.mts') ||
        resolvedFileName.endsWith('.d.cts')
          ? componentPaths.get(mapKey)
          : undefined;

      const propsTypes = new Map<string, ts.Type>([[exportName, propsType]]);
      const docs = extractFromProbe(
        this.typescript,
        checker,
        componentPaths.get(mapKey) ?? resolvedFileName,
        sourceFile,
        propsTypes,
        defaultsSourcePath
      );

      const doc = docs.find((d) => d.exportName === exportName);
      if (doc) {
        results.set(mapKey, doc);
      }
    }

    return results;
  }

  /**
   * Compound component detection.
   *
   * For entries where JSX resolution returned nothing (the imported symbol is a namespace object
   * like `Accordion` with `.Root`, `.Item`, etc.), inspects the type's properties to find
   * component-like ones.
   *
   * A property is component-like if it has call signatures (function component) or construct
   * signatures (class component). We pick the first one whose first parameter resolves to a
   * non-`any` props type.
   *
   * Mutates `allPropsTypes` in place — adds resolved props for compound entries.
   */
  private resolveCompoundTypes(
    checker: ts.TypeChecker,
    probeSF: ts.SourceFile,
    entries: Array<{ importSpecifier: string; exportName: string }>,
    varNameMap: Map<string, string>,
    allPropsTypes: Map<string, ts.Type>
  ): void {
    // Build a set of mapKeys that already have results
    const resolved = new Set<string>();
    for (const key of allPropsTypes.keys()) {
      resolved.add(key);
    }

    // Build a map: prefixed identifier name → mapKey
    // e.g. "_p0_Accordion" → "@park-ui/react::Accordion"
    const identToMapKey = new Map<string, string>();
    let idx = 0;
    const bySpecifier = new Map<string, Array<{ exportName: string }>>();
    for (const { importSpecifier, exportName } of entries) {
      let group = bySpecifier.get(importSpecifier);
      if (!group) {
        group = [];
        bySpecifier.set(importSpecifier, group);
      }
      group.push({ exportName });
    }
    for (const [specifier, candidates] of bySpecifier) {
      const prefix = `_p${idx}_`;
      for (const c of candidates) {
        const identName =
          c.exportName === 'default' ? `${prefix}Default` : `${prefix}${c.exportName}`;
        const mapKey = `${specifier}::${c.exportName}`;
        if (!resolved.has(mapKey)) {
          identToMapKey.set(identName, mapKey);
        }
      }
      idx++;
    }

    if (identToMapKey.size === 0) {
      return;
    }

    // Walk the probe AST to find import bindings for unresolved entries
    for (const stmt of probeSF.statements) {
      if (!this.typescript.isImportDeclaration(stmt)) {
        continue;
      }

      const clause = stmt.importClause;
      if (!clause) {
        continue;
      }

      // Check default import
      if (clause.name) {
        this.tryResolveCompound(checker, clause.name, identToMapKey, allPropsTypes);
      }

      // Check named imports
      if (clause.namedBindings && this.typescript.isNamedImports(clause.namedBindings)) {
        for (const spec of clause.namedBindings.elements) {
          this.tryResolveCompound(checker, spec.name, identToMapKey, allPropsTypes);
        }
      }
    }
  }

  /**
   * Try to resolve a compound component from an imported identifier.
   *
   * Gets the type of the identifier, enumerates its properties, and finds the first one that's a
   * component (has call/construct signatures with a non-`any` first parameter).
   */
  private tryResolveCompound(
    checker: ts.TypeChecker,
    ident: ts.Identifier,
    identToMapKey: Map<string, string>,
    allPropsTypes: Map<string, ts.Type>
  ): void {
    const name = ident.text;
    const mapKey = identToMapKey.get(name);
    if (!mapKey) {
      return;
    }

    const sym = checker.getSymbolAtLocation(ident);
    if (!sym) {
      return;
    }

    const type = checker.getTypeOfSymbolAtLocation(sym, ident);
    const properties = checker.getPropertiesOfType(type);

    // Find component-like properties: ones with call signatures
    // whose first param is a non-`any` object type (= props).
    // Prefer "Root" if present (Ark UI / Radix convention), else first match.
    let bestProp: ts.Symbol | undefined;
    for (const prop of properties) {
      const propType = checker.getTypeOfSymbolAtLocation(prop, ident);
      const callSigs = checker.getSignaturesOfType(propType, this.typescript.SignatureKind.Call);
      if (callSigs.length === 0) {
        continue;
      }

      const sig = callSigs[0];
      const params = sig.getParameters();
      if (params.length === 0) {
        continue;
      }

      const propsType = checker.getTypeOfSymbolAtLocation(params[0], ident);
      if (propsType.flags & this.typescript.TypeFlags.Any) {
        continue;
      }

      if (prop.getName() === 'Root') {
        // Perfect match — use it immediately
        allPropsTypes.set(mapKey, propsType);
        return;
      }
      if (!bestProp) {
        bestProp = prop;
      }
    }

    // Use first component-like property as fallback
    if (bestProp) {
      const propType = checker.getTypeOfSymbolAtLocation(bestProp, ident);
      const callSigs = checker.getSignaturesOfType(propType, this.typescript.SignatureKind.Call);
      if (callSigs.length > 0) {
        const params = callSigs[0].getParameters();
        if (params.length > 0) {
          const propsType = checker.getTypeOfSymbolAtLocation(params[0], ident);
          allPropsTypes.set(mapKey, propsType);
        }
      }
    }
  }

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

// ---------------------------------------------------------------------------
// AST helpers for getCandidatesFromSource — lightweight export detection
// ---------------------------------------------------------------------------

function hasExportModifier(typescript: typeof ts, node: ts.Statement): boolean {
  return (
    typescript.canHaveModifiers(node) &&
    !!typescript.getModifiers(node)?.some((m) => m.kind === typescript.SyntaxKind.ExportKeyword)
  );
}

function hasDefaultModifier(typescript: typeof ts, node: ts.Statement): boolean {
  return (
    typescript.canHaveModifiers(node) &&
    !!typescript.getModifiers(node)?.some((m) => m.kind === typescript.SyntaxKind.DefaultKeyword)
  );
}

function getDeclarationName(typescript: typeof ts, node: ts.Statement): string | undefined {
  // Only value-level declarations can be React components.
  // Interfaces, type aliases, and enums are type-only — skip them.
  if (typescript.isFunctionDeclaration(node) || typescript.isClassDeclaration(node)) {
    return node.name?.text;
  }
  if (typescript.isVariableStatement(node)) {
    const decl = node.declarationList.declarations[0];
    if (decl && typescript.isIdentifier(decl.name)) {
      return decl.name.text;
    }
  }
  return undefined;
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
