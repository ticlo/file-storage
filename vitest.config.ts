import {defineConfig} from 'vitest/config';
import {sharedConfig, sharedTestOptions} from './vitest.config.base';

export default defineConfig({
  ...sharedConfig,
  test: {
    ...sharedTestOptions,
    include: ['test/node/**/*.test.ts', 'packages/file-server/test/**/*.test.ts'],
  },
});
