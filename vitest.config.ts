import { defineConfig } from 'vitest/config';
import { workspaceAliases as alias } from './vitest.aliases.ts';

export default defineConfig({
  test: {
    projects: [
      { resolve: { alias }, test: { name: 'contracts', root: './packages/contracts', include: ['test/**/*.test.ts'] } },
      { resolve: { alias }, test: { name: 'fixtures', root: './fixtures', include: ['test/**/*.test.ts'] } },
      { resolve: { alias }, test: { name: 'metering', root: './packages/metering', include: ['test/**/*.test.ts'] } },
      { resolve: { alias }, test: { name: 'settlement', root: './packages/settlement', include: ['test/**/*.test.ts'] } },
      { resolve: { alias }, test: { name: 'verification', root: './packages/verification', include: ['test/**/*.test.ts'] } },
      // SPEC 04 cross-package scenarios S1/F1-F7 (offline, SDK_INTEGRATION) and the demo narrative.
      { resolve: { alias }, test: { name: 'integration', root: './apps/demo', include: ['test/**/*.test.ts'], testTimeout: 60_000 } },
    ],
  },
});
