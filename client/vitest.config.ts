import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';

import { playwright } from '@vitest/browser-playwright';
import react from '@vitejs/plugin-react';

const dirname =
  typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));

const storybookConfigDir = path.join(dirname, '.storybook');
const storybookProjects = process.env.VITEST_STORYBOOK === '1' && fs.existsSync(storybookConfigDir)
  ? [
      {
        extends: true,
        plugins: [
          storybookTest({ configDir: storybookConfigDir }),
        ],
        test: {
          name: 'storybook',
          browser: {
            enabled: true,
            headless: true,
            provider: playwright({}),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ]
  : [];

// More info at: https://storybook.js.org/docs/next/writing-tests/integrations/vitest-addon
const defaultTestConfig = {
  globals: true,
  environment: 'jsdom',
  setupFiles: ['./lib/test-utils/setup.ts'],
  include: ['**/*.{test,spec}.{ts,tsx}'],
  exclude: ['node_modules', '.storybook', 'stories', 'e2e', '.next'],
  coverage: {
    provider: 'v8',
    reporter: ['text', 'html', 'json-summary', 'lcov'],
    exclude: [
      'node_modules/',
      '.storybook/',
      '**/*.stories.tsx',
      '**/*.stories.ts',
      '**/*.config.ts',
      '**/*.config.js',
      '**/*.config.mjs',
      '**/types.ts',
      '**/*.types.d.ts',
      '**/*.d.ts',
      'e2e/',
      'stories/',
      'public/',
      '.next/',
      'coverage/',
    ],
    thresholds: {
      lines: 80,
      branches: 75,
      functions: 85,
      statements: 80,
    },
  },
};

if (storybookProjects.length > 0) {
  defaultTestConfig.projects = storybookProjects;
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(dirname, './'),
    },
  },
  test: defaultTestConfig,
});
