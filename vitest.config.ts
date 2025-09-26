import {defineConfig} from 'vitest/config';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@ticlo/file-server': resolve(rootDir, 'packages/file-server/src/index.ts'),
      '@ticlo/file-client': resolve(rootDir, 'packages/file-client/src/index.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    environmentMatchGlobs: [['test/browser/**/*.test.ts', 'jsdom']],
    testTimeout: 20000,
    hookTimeout: 30000,
    sequence: {
      concurrent: false,
    },
  },
});
