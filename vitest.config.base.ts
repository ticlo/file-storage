import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import type {UserConfig} from 'vitest';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

export const sharedConfig: Pick<UserConfig, 'resolve' | 'envPrefix'> = {
  resolve: {
    alias: {
      '@ticlo/file-server': resolve(rootDir, 'packages/file-server/src/index.ts'),
      '@ticlo/file-client': resolve(rootDir, 'packages/file-client/src/index.ts'),
    },
  },
  envPrefix: ['VITE_', 'VITEST_', 'TEST_'],
};

export const sharedTestOptions = {
  environment: 'node',
  testTimeout: 20000,
  hookTimeout: 30000,
  sequence: {
    concurrent: false,
  },
} satisfies NonNullable<UserConfig['test']>;
