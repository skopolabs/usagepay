import { defineConfig } from 'vitest/config';
import { workspaceAliases as alias } from './vitest.aliases.ts';

export default defineConfig({
  test: {
    projects: [
      { resolve: { alias }, test: { name: 'contracts', root: './packages/contracts', include: ['test/**/*.test.ts'] } },
      { resolve: { alias }, test: { name: 'fixtures', root: './fixtures', include: ['test/**/*.test.ts'] } },
    ],
  },
});
