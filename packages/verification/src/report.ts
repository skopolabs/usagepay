import { CHECK_IDS } from './result.js';
import type { VerificationReport } from './verifier.js';

const LIMITATIONS = [
  'PHYSICAL METER CERTIFICATION: NOT PROVIDED (simulated meter key)',
  'METER VALIDITY ENFORCED ON-CHAIN: NOT PROVIDED (the channel contract checks the financial amount only)',
  'CONFIDENTIAL PAYMENT AMOUNTS: NOT PROVIDED (public Stellar USDC channel)',
];

/** SPEC 03 §4 text projection of a report. Public values only; raw meter payloads are never printed. */
export function formatReport(report: VerificationReport): string {
  const { subject } = report;
  const lines = [
    'UsagePay Verify — Stellar Testnet',
    `Session: ${subject.sessionId ?? '(unreadable E0)'}`,
    `E0 digest (recomputed): ${subject.e0Digest ?? '(unreadable E0)'}`,
    `Close tx (from E1): ${subject.closeTxHash ?? '(unreadable E1)'}`,
    ...subject.increments.map((i) => `  ${i.readingId}: cumulative ${i.cumulativeWh} Wh -> ${i.cumulativeChargeBaseUnits} base units`),
    '',
    ...CHECK_IDS.map((id) => {
      const check = report.checks[id];
      return `${id.padEnd(15)} ${check.status.padEnd(13)} ${check.reasonCode}\n${' '.repeat(16)}${check.details}`;
    }),
    '',
    `OVERALL: ${report.overall.status} (${report.overall.reasonCode}: ${report.overall.details})`,
    ...LIMITATIONS,
  ];
  return `${lines.join('\n')}\n`;
}
