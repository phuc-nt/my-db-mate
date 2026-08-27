/**
 * Module boundaries, enforced.
 *
 * `docs/module-map.md` explains which module owns what and why; this file is
 * what actually fails the build. The rules land in two waves on purpose:
 *
 *   - The `core`/`modules` rules below are written against the POST-move paths
 *     (`src/core/**`, `src/modules/<name>/**`). They match nothing today, which
 *     is intentional — each becomes live the moment its files land there, with
 *     no baseline-exclusion stage where a violation is merely recorded. A rule
 *     that ships with a list of known violations teaches everyone to add to the
 *     list.
 *   - The two rules that CAN hold today (no cycles, no service→app import) are
 *     hard from the start.
 *
 * A cross-module import is legal only through the target's `index.ts`. The
 * allowed feature→feature edges are listed in the module map; this config
 * enforces the *shape* (via a barrel) rather than the specific pairs, because
 * pinning pairs here would mean editing two files for every legitimate new edge
 * and the barrel is what keeps the surface reviewable.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'A cycle means neither file can be understood, tested, or moved on its own. ' +
        'Break it by extracting the shared piece into core.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-server-to-app',
      severity: 'error',
      comment:
        'Services and shared libs must not import from src/app. Route files are wiring: ' +
        'they depend on services, never the reverse. An import in this direction drags ' +
        "Next.js's request context into code that is supposed to be callable headlessly " +
        '(the benchmark runner and the MCP server both call services with no request).',
      from: { path: '^src/(services|lib|core|modules)/' },
      to: { path: '^src/app/' },
    },
    {
      name: 'core-imports-no-feature',
      severity: 'error',
      comment:
        'src/core is the kernel every feature builds on. If a core file needs a feature, ' +
        'the dependency is backwards — either the code belongs in that feature, or the ' +
        'part core needs belongs in core.',
      from: { path: '^src/core/' },
      // `services` is kept in the pattern although the directory is gone: it is
      // the name feature code would land under if someone recreated the flat
      // layout, and this rule should catch that rather than pass it.
      to: { path: '^src/(modules|services)/' },
    },
    {
      name: 'module-crossing-needs-barrel',
      severity: 'error',
      comment:
        "A feature module may use another module only through its index.ts. Reaching past " +
        'the barrel couples you to the target\'s internals, which is exactly what this ' +
        'restructure removes. If index.ts does not export what you need, that is a design ' +
        'conversation, not a barrel edit.',
      from: { path: '^src/modules/([^/]+)/' },
      // Any path inside a DIFFERENT module that is not that module's index.
      to: {
        path: '^src/modules/([^/]+)/',
        pathNot: ['^src/modules/$1/', '^src/modules/[^/]+/index\\.ts$'],
      },
    },
    {
      name: 'no-orphan-modules',
      severity: 'warn',
      comment: 'Nothing imports this file — dead code left behind by a move, or a missing wire-up.',
      from: {
        orphan: true,
        pathNot: [
          '\\.d\\.ts$',
          '(^|/)\\.[^/]+\\.(js|cjs|ts)$',
          '^src/app/',
          '\\.test\\.ts$',
          // Child processes: forked by file URL (`new URL('./x-exec-child.cjs', ...)`),
          // so no import edge exists for the cruiser to follow. They are live code.
          'exec-child\\.cjs$',
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: {
      // Test files import across boundaries by nature (a test for a module's
      // internals must reach its internals). The boundary that matters is the
      // one in shipped code.
      path: ['\\.test\\.ts$', '\\.test\\.tsx$', 'node_modules'],
    },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.js', '.jsx', '.ts', '.tsx'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
