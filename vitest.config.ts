import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // App tests only — the working tree also carries untracked dev tooling
    // with its own test files that must not run here.
    include: ['src/**/*.test.ts'],
  },
});
