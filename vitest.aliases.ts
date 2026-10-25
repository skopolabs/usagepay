import { fileURLToPath } from 'node:url';

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** Workspace packages resolve to their TypeScript sources so tests never depend on a prior build. */
export const workspaceAliases = [
  { find: /^@usagepay\/contracts$/, replacement: src('./packages/contracts/src/index.ts') },
  { find: /^@usagepay\/fixtures$/, replacement: src('./fixtures/src/index.ts') },
  { find: /^@usagepay\/metering$/, replacement: src('./packages/metering/src/index.ts') },
  { find: /^@usagepay\/settlement$/, replacement: src('./packages/settlement/src/index.ts') },
  { find: /^@usagepay\/verification$/, replacement: src('./packages/verification/src/index.ts') },
  { find: /^@usagepay\/demo$/, replacement: src('./apps/demo/src/index.ts') },
];
