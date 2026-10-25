#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createStellarChainReader } from '@usagepay/verification';
import { runDemo } from './cli.js';

process.exitCode = await runDemo(process.argv.slice(2), {
  cwd: process.cwd(),
  chainReader: (rpcUrl) => createStellarChainReader({ rpcUrl }),
  writeFile: (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  },
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  color: process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined,
});
