import {defineConfig} from 'vitest/config';
import {sharedConfig, sharedTestOptions} from './vitest.config.base';

export default defineConfig({
  ...sharedConfig,
  test: {
    ...sharedTestOptions,
    include: ['test/browser/**/*.test.ts'],
    browser: {
      enabled: true,
      name: 'chrome',
      headless: true,
      provider: 'webdriverio',
      options: {
        automationProtocol: 'devtools',
        capabilities: {
          browserName: 'chrome',
          'goog:chromeOptions': {
            args: ['--headless=new', '--disable-gpu', '--no-sandbox'],
          },
        },
      },
    },
    globalSetup: ['./test/browser/globalSetup.ts'],
  },
});
