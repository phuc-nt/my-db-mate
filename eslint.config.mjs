import coreWebVitals from 'eslint-config-next/core-web-vitals';
import typescript from 'eslint-config-next/typescript';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  ...coreWebVitals,
  ...typescript,
  {
    ignores: ['.next/**', 'node_modules/**', 'scripts/**', 'cloud-test/**'],
  },
  {
    // CommonJS by design: the SQLite exec child must load without transpile.
    files: ['**/*.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // `const { secretEncrypted, ...safe } = row` strips credentials from API
    // responses — the discarded binding is the point, not an oversight.
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { ignoreRestSiblings: true }],
    },
  },
  {
    // Fetch-on-mount pages set loading state synchronously in effects; advisory
    // (render-performance) rather than a correctness issue — keep visible as warnings.
    files: ['**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: { 'react-hooks/set-state-in-effect': 'warn' },
  },
];
