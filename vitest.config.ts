import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@omnimesh/core': path.resolve(__dirname, './packages/core/src/index.ts'),
      '@omnimesh/node': path.resolve(__dirname, './packages/node/src/index.ts'),
      '@omnimesh/router': path.resolve(__dirname, './packages/router/src/index.ts'),
      '@omnimesh/providers': path.resolve(__dirname, './packages/providers/src/index.ts'),
      '@omnimesh/cli': path.resolve(__dirname, './packages/cli/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});
