import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';

const dotenvResult = config();

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    env: dotenvResult.parsed,
    coverage: {
      provider: 'v8',
      all: true,
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/evals/**'],
      reporter: ['text-summary', 'json-summary', 'html'],
      thresholds: {
        autoUpdate: true,
        lines: 21.99,
        statements: 21.38,
        functions: 32.77,
        branches: 20.42,
      },
    },
  },
});
