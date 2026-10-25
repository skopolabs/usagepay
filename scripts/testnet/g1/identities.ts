import { execFileSync } from 'node:child_process';

/** Disposable Testnet identities created by setup-identities.sh (Testnet naming rule: "upay" prefix). */
export const IDENTITIES = {
  funder: 'upay-g1-payer',
  recipient: 'upay-g1-recipient',
  commitment: 'upay-g1-commitment',
} as const;

export function identityAddress(name: string): string {
  return execFileSync('stellar', ['keys', 'address', name], { encoding: 'utf8' }).trim();
}

/**
 * Reads a secret from the Stellar CLI keystore (outside the repo). The caller must hand it only to the role that
 * owns it and must never log, trace or persist it.
 */
export function identitySecret(name: string): string {
  return execFileSync('stellar', ['keys', 'secret', name], { encoding: 'utf8' }).trim();
}

export function channelAddress(alias: string): string {
  return execFileSync('stellar', ['contract', 'alias', 'show', alias, '--network', 'testnet'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}
