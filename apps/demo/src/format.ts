/** Display helpers shared by the terminal walkthrough and the demo bundle. Integer arithmetic only. */

export const EXPLORER = 'https://stellar.expert/explorer/testnet';

export const explorerLinks = {
  tx: (hash: string) => `${EXPLORER}/tx/${hash}`,
  contract: (id: string) => `${EXPLORER}/contract/${id}`,
  account: (id: string) => `${EXPLORER}/account/${id}`,
};

/** `3000000` base units of a 7-decimal asset -> `0.30 USDC` (at least two decimals, trailing zeros trimmed). */
export function formatAmount(baseUnits: string | bigint, decimals = 7, code = 'USDC'): string {
  const value = BigInt(baseUnits);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const fraction = (abs % scale).toString().padStart(decimals, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${negative ? '-' : ''}${abs / scale}.${fraction} ${code}`;
}

/** `250` Wh -> `0.25 kWh`. */
export function formatEnergy(wh: string | bigint): string {
  const value = BigInt(wh);
  const fraction = (value % 1000n).toString().padStart(3, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${value / 1000n}.${fraction} kWh`;
}

/** Shortens a hash, key or address for display: `1a4939…b676`. */
export function short(value: string, head = 6, tail = 4): string {
  return value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}

/** JSON with bigints as decimal strings. */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n';
}
