import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

export default defineConfig({
  // Mirror tsconfig's `@/*` path alias. Next resolves it from tsconfig; vitest
  // does not, so without this every `@/`-form import fails to resolve at test time.
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    // App tests only — the working tree also carries untracked dev tooling
    // with its own test files that must not run here.
    include: ['src/**/*.test.ts'],
  },
});
