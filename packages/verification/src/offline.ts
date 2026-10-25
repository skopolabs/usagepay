import {
  EvidenceE0Schema,
  EvidenceE1Schema,
  accountIdToPublicKey,
  base64ToBytes,
  computeCommitmentDigest,
  computeE0Digest,
  computeEvidenceDigest,
  computeReadingDigest,
  computeTariffVersionDigest,
  cumulativeChargeBaseUnits,
  decimalToBigInt,
  decodeSimMeterPayload,
  isoTimeMs,
  verifyEd25519,
  verifyMeterReadingSignature,
  verifyPayerAckSignature,
  type EvidenceE0,
  type EvidenceE1,
  type MeterReading,
  type SimMeterPayload,
  type VerificationResult,
} from '@usagepay/contracts';
import type { CommitmentEncoding } from './encoding.js';
import { fromIssues, type Issue } from './result.js';
import type { VerifierTrust } from './trust.js';

/**
 * SPEC 03 V01-V07: offline re-computation from the E0/E1 bytes and the pinned trust inputs only. Nothing here trusts
 * a stored digest, flag or amount: every value is recomputed and then compared.
 */

/** Shortens a public address or digest for display; never applied to secrets (the verifier holds none). */
export function short(value: string): string {
  return value.length > 12 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value;
}

/** Charges replayed with bigint from the signed-and-checked reading deltas and the E0 tariff (floor_cumulative). */
export interface ReplayedCharge {
  readonly cumulativeWh: bigint;
  readonly cumulative: bigint;
  readonly delta: bigint;
}

export function replayCharges(e0: EvidenceE0): ReplayedCharge[] {
  const price = decimalToBigInt(e0.tariff.pricePerKwhBaseUnits);
  let cumulativeWh = 0n;
  let prior = 0n;
  return e0.increments.map(({ reading }) => {
    cumulativeWh += decimalToBigInt(reading.deltaWh);
    const cumulative = cumulativeChargeBaseUnits(cumulativeWh, price);
    const replayed = { cumulativeWh, cumulative, delta: cumulative - prior };
    prior = cumulative;
    return replayed;
  });
}

function schemaIssue(label: string, error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): Issue {
  const shown = error.issues.slice(0, 3).map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`);
  const more = error.issues.length > 3 ? ` (+${error.issues.length - 3} more)` : '';
  return { code: 'INVALID_SCHEMA', detail: `${label}: ${shown.join(', ')}${more}` };
}

/** V01: strict SPEC 00 schemas (formats, network, sequence order, unique readings and ack nonces, no extra fields). */
export function checkSchemas(e0: unknown, e1: unknown): { result: VerificationResult; e0?: EvidenceE0; e1?: EvidenceE1 } {
  const parsedE0 = EvidenceE0Schema.safeParse(e0);
  const parsedE1 = EvidenceE1Schema.safeParse(e1);
  const issues: Issue[] = [];
  if (!parsedE0.success) issues.push(schemaIssue('E0', parsedE0.error));
  if (!parsedE1.success) issues.push(schemaIssue('E1', parsedE1.error));
  const count = parsedE0.success ? parsedE0.data.increments.length : 0;
  return {
    result: fromIssues(issues, `E0 (${count} increments, sequences 1..${count}, unique readings and ack nonces) and E1 match the SPEC 00 v1 schemas`),
    ...(parsedE0.success ? { e0: parsedE0.data } : {}),
    ...(parsedE1.success ? { e1: parsedE1.data } : {}),
  };
}

function signedPayload(reading: MeterReading): SimMeterPayload | string {
  try {
    return decodeSimMeterPayload(base64ToBytes(reading.rawPayloadB64));
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function envelopeMatches(payload: SimMeterPayload, reading: MeterReading): boolean {
  return (
    payload.domain === reading.domain &&
    payload.sessionId === reading.sessionId &&
    payload.machineId === reading.machineId &&
    payload.readingId === reading.readingId &&
    payload.observedAt === reading.observedAt &&
    payload.intervalStart === reading.intervalStart &&
    payload.intervalEnd === reading.intervalEnd &&
    decimalToBigInt(payload.meterEndWh) - decimalToBigInt(payload.meterStartWh) === decimalToBigInt(reading.deltaWh)
  );
}

/** V02: pinned meter key over the exact source bytes, envelope = signed payload, counter and interval continuity. */
export function checkMeter(e0: EvidenceE0, trust: VerifierTrust): VerificationResult {
  const issues: Issue[] = [];
  const signers = new Set<string>();
  let previous: { reading: MeterReading; payload: SimMeterPayload | undefined } | undefined;
  let firstStart: string | undefined;
  let lastEnd: string | undefined;
  for (const { reading } of e0.increments) {
    const id = reading.readingId;
    const key = reading.signerKeyId === undefined ? undefined : trust.meterKeys.get(reading.signerKeyId);
    let payload: SimMeterPayload | undefined;
    if (reading.signerKeyId === undefined) {
      issues.push({ code: 'INVALID_METER_SIGNATURE', detail: `${id}: reading carries no source signature` });
    } else if (key === undefined) {
      issues.push({ code: 'UNKNOWN_METER_KEY', detail: `${id}: signer key "${reading.signerKeyId}" is not in the pinned meter registry` });
    } else if (!verifyMeterReadingSignature(reading, key)) {
      issues.push({ code: 'INVALID_METER_SIGNATURE', detail: `${id}: signature does not verify over the exact source bytes under pinned key "${reading.signerKeyId}"` });
    } else {
      signers.add(reading.signerKeyId);
      const decoded = signedPayload(reading);
      if (typeof decoded === 'string') {
        issues.push({ code: 'SIGNED_PAYLOAD_MISMATCH', detail: `${id}: ${decoded}` });
      } else if (!envelopeMatches(decoded, reading)) {
        issues.push({ code: 'SIGNED_PAYLOAD_MISMATCH', detail: `${id}: reading fields differ from its signed source payload` });
      } else {
        payload = decoded;
        firstStart ??= decoded.meterStartWh;
        lastEnd = decoded.meterEndWh;
      }
    }
    if (previous !== undefined) {
      if (previous.reading.coverage === 'terminal_signed') {
        issues.push({ code: 'COUNTER_DISCONTINUITY', detail: `${id}: follows terminal reading ${previous.reading.readingId}` });
      } else if (reading.intervalStart !== previous.reading.intervalEnd) {
        issues.push({ code: 'COUNTER_DISCONTINUITY', detail: `${id}: interval starts at ${reading.intervalStart}, not at the prior end ${previous.reading.intervalEnd}` });
      } else if (payload !== undefined && previous.payload !== undefined && payload.meterStartWh !== previous.payload.meterEndWh) {
        issues.push({ code: 'COUNTER_DISCONTINUITY', detail: `${id}: signed counter starts at ${payload.meterStartWh} Wh, prior signed end is ${previous.payload.meterEndWh} Wh` });
      }
    }
    previous = { reading, payload };
  }
  const certification = [...new Set(e0.increments.map(({ reading }) => reading.certification))].join(', ');
  const result = fromIssues(
    issues,
    `${e0.increments.length} readings signed by pinned key(s) ${[...signers].join(', ')} over the exact source bytes; ` +
      `signed counter ${firstStart ?? '?'} -> ${lastEnd ?? '?'} Wh, contiguous`,
  );
  return { ...result, details: `${result.details}; certification: ${certification} (signature validity is not hardware certification)` };
}

/** V03: pinned tariff identity and window, pinned asset, bigint charge replay and the fleet budget cap (AC13). */
export function checkTariff(e0: EvidenceE0, trust: VerifierTrust, replay: readonly ReplayedCharge[]): VerificationResult {
  const issues: Issue[] = [];
  const { tariff } = e0;
  if (tariff.assetSac !== trust.assetSac) {
    issues.push({ code: 'ASSET_MISMATCH', detail: `tariff asset ${short(tariff.assetSac)} is not the pinned asset SAC ${short(trust.assetSac)}` });
  }
  const recomputed = computeTariffVersionDigest(tariff);
  if (recomputed !== tariff.versionDigest) {
    issues.push({ code: 'TARIFF_DIGEST_MISMATCH', detail: `tariff versionDigest does not recompute (got ${short(recomputed)})` });
  } else if (recomputed !== trust.tariffVersionDigest) {
    issues.push({ code: 'TARIFF_DIGEST_MISMATCH', detail: `tariff ${short(recomputed)} is not the pinned tariff ${short(trust.tariffVersionDigest)}` });
  }
  const cap = decimalToBigInt(trust.budgetCapBaseUnits);
  e0.increments.forEach(({ reading, charge }, index) => {
    const id = reading.readingId;
    const replayed = replay[index]!;
    if (charge.tariffVersionDigest !== recomputed) {
      issues.push({ code: 'TARIFF_DIGEST_MISMATCH', detail: `${id}: charge references tariff ${short(charge.tariffVersionDigest)}` });
    }
    const active =
      isoTimeMs(reading.intervalStart) >= isoTimeMs(tariff.validFrom) &&
      (tariff.validUntil === undefined || isoTimeMs(reading.intervalEnd) <= isoTimeMs(tariff.validUntil));
    if (!active) {
      issues.push({ code: 'TARIFF_NOT_ACTIVE', detail: `${id}: interval [${reading.intervalStart}, ${reading.intervalEnd}) is outside the tariff validity` });
    }
    if (
      decimalToBigInt(charge.cumulativeWh) !== replayed.cumulativeWh ||
      decimalToBigInt(charge.cumulativeChargeBaseUnits) !== replayed.cumulative ||
      decimalToBigInt(charge.deltaChargeBaseUnits) !== replayed.delta
    ) {
      issues.push({
        code: 'CHARGE_REPLAY_MISMATCH',
        detail:
          `${id}: replay gives ${replayed.cumulativeWh} Wh / ${replayed.cumulative} / delta ${replayed.delta}, ` +
          `recorded ${charge.cumulativeWh} Wh / ${charge.cumulativeChargeBaseUnits} / delta ${charge.deltaChargeBaseUnits}`,
      });
    }
    if (replayed.cumulative > cap) {
      issues.push({ code: 'BUDGET_EXCEEDED', detail: `${id}: cumulative ${replayed.cumulative} exceeds the pinned budget cap ${cap}` });
    }
  });
  return fromIssues(
    issues,
    `pinned tariff ${tariff.tariffId} (${short(recomputed)}), ${tariff.pricePerKwhBaseUnits} base units/kWh, floor_cumulative; ` +
      `replayed ${replay.map((r) => r.cumulative).join(' -> ')} within cap ${cap}`,
  );
}

/** V04: pinned session, recomputed reading and evidence digests, strictly increasing approved cumulatives. */
export function checkEvidence(e0: EvidenceE0, trust: VerifierTrust): VerificationResult {
  const issues: Issue[] = [];
  if (e0.sessionId !== trust.sessionId) {
    issues.push({ code: 'SESSION_MISMATCH', detail: `E0 session ${e0.sessionId} is not the pinned session ${trust.sessionId}` });
  }
  let prior = 0n;
  for (const { reading, charge } of e0.increments) {
    const id = reading.readingId;
    if (reading.sessionId !== trust.sessionId || charge.sessionId !== trust.sessionId) {
      issues.push({ code: 'SESSION_MISMATCH', detail: `${id}: reading/charge session ${reading.sessionId}/${charge.sessionId} is not the pinned session` });
    }
    if (charge.readingId !== id) issues.push({ code: 'EVIDENCE_DIGEST_MISMATCH', detail: `${id}: charge belongs to reading ${charge.readingId}` });
    if (charge.readingDigest !== computeReadingDigest(reading)) {
      issues.push({ code: 'EVIDENCE_DIGEST_MISMATCH', detail: `${id}: readingDigest does not recompute from the reading` });
    }
    const { schema: _schema, evidenceDigest, ...preimage } = charge;
    if (computeEvidenceDigest(preimage) !== evidenceDigest) {
      issues.push({ code: 'EVIDENCE_DIGEST_MISMATCH', detail: `${id}: evidenceDigest does not recompute from the SPEC 00 preimage` });
    }
    const cumulative = decimalToBigInt(charge.cumulativeChargeBaseUnits);
    if (cumulative <= prior) issues.push({ code: 'NON_MONOTONIC_CUMULATIVE', detail: `${id}: cumulative ${cumulative} does not exceed ${prior}` });
    prior = cumulative;
  }
  return fromIssues(issues, `session ${e0.sessionId}: ${e0.increments.length} reading and evidence digests recompute; cumulatives strictly increase`);
}

/** V05: the captured native MPP commitments, re-encoded (never re-signed) and verified under the pinned key. */
export function checkNativeCommitments(
  e0: EvidenceE0,
  trust: VerifierTrust,
  encoding: CommitmentEncoding,
  replay: readonly ReplayedCharge[],
): VerificationResult {
  const issues: Issue[] = [];
  const pinnedKey = accountIdToPublicKey(trust.commitmentKey);
  const invalid = (detail: string) => issues.push({ code: 'NATIVE_COMMITMENT_INVALID', detail });
  let prior = 0n;
  e0.increments.forEach(({ reading, commitment }, index) => {
    const id = reading.readingId;
    const amount = decimalToBigInt(commitment.cumulativeAmountBaseUnits);
    if (commitment.channelId !== trust.channelId) invalid(`${id}: commitment channel ${short(commitment.channelId)} is not the pinned channel`);
    if (commitment.commitmentKey !== trust.commitmentKey) invalid(`${id}: commitmentKey ${short(commitment.commitmentKey)} is not the pinned commitment key`);
    if (computeCommitmentDigest(commitment) !== commitment.commitmentDigest) invalid(`${id}: commitmentDigest does not recompute`);
    if (amount !== replay[index]!.cumulative) invalid(`${id}: commitment amount ${amount} is not the replayed cumulative charge ${replay[index]!.cumulative}`);
    const message = base64ToBytes(commitment.signedMessageB64);
    if (!Buffer.from(message).equals(Buffer.from(encoding(trust.channelId, amount)))) {
      invalid(`${id}: signed message is not the pinned encoding of (pinned channel, ${amount}, testnet)`);
    }
    if (!verifyEd25519(pinnedKey, message, base64ToBytes(commitment.signatureB64))) {
      invalid(`${id}: native signature does not verify under the pinned commitment key`);
    }
    if (amount <= prior) issues.push({ code: 'NON_MONOTONIC_CUMULATIVE', detail: `${id}: commitment ${amount} does not exceed ${prior}` });
    prior = amount;
  });
  return fromIssues(
    issues,
    `${e0.increments.length} native commitments ${e0.increments.map((i) => i.commitment.cumulativeAmountBaseUnits).join(' -> ')} ` +
      `equal the pinned encoding for ${short(trust.channelId)} and verify under ${short(trust.commitmentKey)}`,
  );
}

/** V06: payer acks over the exact domain-separated message, bound to the same increment and the pinned identities. */
export function checkPayerAcks(e0: EvidenceE0, trust: VerifierTrust): VerificationResult {
  const issues: Issue[] = [];
  const invalid = (detail: string) => issues.push({ code: 'PAYER_ACK_INVALID', detail });
  const nonces = new Set<string>();
  for (const { reading, charge, commitment, payerAck: ack } of e0.increments) {
    const id = reading.readingId;
    if (!verifyPayerAckSignature(ack)) invalid(`${id}: ack signature does not verify over the domain-separated JCS message`);
    if (ack.payerKey !== trust.commitmentKey) invalid(`${id}: ack payerKey ${short(ack.payerKey)} is not the pinned payer commitment key`);
    if (ack.sessionId !== trust.sessionId || ack.sessionId !== charge.sessionId) invalid(`${id}: ack session ${ack.sessionId} is not the increment's pinned session`);
    if (ack.channelId !== trust.channelId || ack.channelId !== commitment.channelId) invalid(`${id}: ack channel ${short(ack.channelId)} is not the pinned commitment channel`);
    if (ack.network !== trust.network || ack.network !== commitment.network) invalid(`${id}: ack network ${ack.network} is not ${trust.network}`);
    const { schema: _schema, evidenceDigest, ...preimage } = charge;
    if (ack.evidenceDigest !== evidenceDigest || ack.evidenceDigest !== computeEvidenceDigest(preimage)) {
      invalid(`${id}: ack binds evidence ${short(ack.evidenceDigest)}, not this increment's recomputed evidence digest`);
    }
    if (ack.commitmentDigest !== computeCommitmentDigest(commitment)) invalid(`${id}: ack does not bind the recomputed native commitment digest`);
    if (ack.approvedCumulativeBaseUnits !== commitment.cumulativeAmountBaseUnits) {
      invalid(`${id}: ack approves ${ack.approvedCumulativeBaseUnits}, the commitment authorizes ${commitment.cumulativeAmountBaseUnits}`);
    }
    const nonceKey = JSON.stringify([ack.channelId, ack.sessionId, ack.nonce]);
    if (nonces.has(nonceKey)) invalid(`${id}: ack nonce reused within (channel, session)`);
    nonces.add(nonceKey);
  }
  return fromIssues(issues, `${e0.increments.length} payer acks verify under ${short(trust.commitmentKey)} and bind evidence, commitment, amount, session, channel and network`);
}

/** V07: E1 references exactly this E0 (recomputed digest) and the pinned network, channel and asset. */
export function checkE0E1Link(e0: EvidenceE0, e1: EvidenceE1, trust: VerifierTrust): VerificationResult {
  const issues: Issue[] = [];
  const digest = computeE0Digest(e0);
  if (digest !== e1.e0Digest) issues.push({ code: 'E0_DIGEST_MISMATCH', detail: `SHA256(JCS(E0)) = ${short(digest)}, E1 references ${short(e1.e0Digest)}` });
  const mismatch = (detail: string) => issues.push({ code: 'CHAIN_MISMATCH', detail });
  if (e1.network !== trust.network) mismatch(`E1 network ${e1.network} is not ${trust.network}`);
  if (e1.channelId !== trust.channelId) mismatch(`E1 channel ${short(e1.channelId)} is not the pinned channel ${short(trust.channelId)}`);
  if (e1.assetSac !== trust.assetSac || e1.assetSac !== e0.tariff.assetSac) mismatch(`E1 asset ${short(e1.assetSac)} is not the pinned/tariff asset`);
  if (e0.increments.some(({ commitment }) => commitment.channelId !== e1.channelId)) mismatch('E1 channel differs from the E0 commitments');
  return fromIssues(issues, `E1.e0Digest = SHA256(JCS(E0)) = ${digest}; network, channel and asset match the pins`);
}

