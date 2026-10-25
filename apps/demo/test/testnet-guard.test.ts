import { describe, expect, it } from 'vitest';
import { TESTNET_PASSPHRASE, testnetGuard } from '../src/index.js';

const testnet = { id: 'stellar:testnet', networkPassphrase: TESTNET_PASSPHRASE };
const rpcUrl = 'https://soroban-testnet.stellar.org';
const optIn = { UPAY_TESTNET_E2E: '1' };

describe('SPEC 04 Testnet E2E guard', () => {
  it('runs only with the explicit opt-in and a Testnet configuration', () => {
    expect(testnetGuard({ env: optIn, network: testnet, rpcUrl, rpcPassphrase: TESTNET_PASSPHRASE })).toBeNull();
  });

  it.each([
    ['no opt-in', { env: {}, network: testnet, rpcUrl }, /opt-in/],
    ['opt-in not exactly 1', { env: { UPAY_TESTNET_E2E: 'yes' }, network: testnet, rpcUrl }, /opt-in/],
    ['configuration absent', { env: optIn, network: undefined, rpcUrl }, /no network configuration/],
    ['mainnet network id', { env: optIn, network: { ...testnet, id: 'stellar:pubnet' }, rpcUrl }, /not stellar:testnet/],
    ['mainnet passphrase', { env: optIn, network: { ...testnet, networkPassphrase: 'Public Global Stellar Network ; September 2015' }, rpcUrl }, /passphrase/],
    ['mainnet RPC', { env: optIn, network: testnet, rpcUrl: 'https://mainnet.sorobanrpc.com' }, /not a Testnet endpoint/],
    ['RPC reports another network', { env: optIn, network: testnet, rpcUrl, rpcPassphrase: 'Public Global Stellar Network ; September 2015' }, /non-Testnet passphrase/],
  ])('refuses: %s', (_name, input, reason) => {
    expect(testnetGuard(input)).toMatch(reason);
  });
});
