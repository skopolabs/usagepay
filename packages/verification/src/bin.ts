#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { runCli } from './cli.js';
import { createStellarChainReader } from './stellar-reader.js';

process.exitCode = await runCli(process.argv.slice(2), {
  readFile: (path) => readFileSync(path, 'utf8'),
  chainReader: (rpcUrl) => createStellarChainReader({ rpcUrl }),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
