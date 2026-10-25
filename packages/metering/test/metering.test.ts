import { describe, expect, it } from 'vitest';
import {
  MeasurementChargeSchema,
  MeterReadingSchema,
  base64ToBytes,
  bytesToBase64,
  canonicalize,
  computeTariffVersionDigest,
  utf8Bytes,
  type TariffSnapshot,
} from '@usagepay/contracts';
import { buildGoldenSession, readFixtureJson } from '@usagepay/fixtures';
import {
  applyAll,
  clone,
  goldenCharger,
  goldenEvents,
  goldenSession,
  goldenTariff,
  inputs,
  rejection,
  trustedSigner,
  untrustedSigner,
} from './helpers.js';
import type { MeteringOutcome, SimulatedOcppEvent } from '../src/index.js';

function accepted(outcomes: MeteringOutcome[]) {
  return outcomes.flatMap((o) => (o.kind === 'ACCEPTED' ? [o] : []));
}

function signedPart(event: SimulatedOcppEvent | undefined) {
  if (event?.usagepaySimulator === undefined) throw new Error('event carries no signed payload');
  return event.usagepaySimulator;
}

describe('S1-A three valid signed intervals', () => {
  it('accepts Started + 250/250/250 Wh with cumulative 1000000, 2000000, 3000000', async () => {
    const outcomes = await applyAll(goldenSession(), goldenEvents());
    expect(outcomes[0]).toEqual({ kind: 'SESSION_STARTED', sessionId: 'ev-session-001' });
    const charges = accepted(outcomes).map((o) => o.charge);
    expect(charges.map((c) => c.cumulativeChargeBaseUnits)).toEqual(['1000000', '2000000', '3000000']);
    expect(charges.map((c) => c.deltaChargeBaseUnits)).toEqual(['1000000', '1000000', '1000000']);
    expect(charges.map((c) => c.cumulativeWh)).toEqual(['250', '500', '750']);
    expect(accepted(outcomes).map((o) => o.reading.coverage)).toEqual([
      'intermediate_signed',
      'intermediate_signed',
      'terminal_signed',
    ]);
  });

  it('closes the session after an accepted Ended reading', async () => {
    const session = goldenSession();
    const events = goldenEvents();
    await applyAll(session, events);
    expect(rejection(await session.apply(goldenCharger().ended()))).toBe('SESSION_CLOSED');
  });

  it('reports SESSION_ENDED without a charge when Ended carries no reading', async () => {
    const session = goldenSession();
    const events = goldenEvents().slice(0, 3);
    const charger = goldenCharger();
    await applyAll(session, events);
    expect(await session.apply(charger.ended())).toEqual({ kind: 'SESSION_ENDED', sessionId: 'ev-session-001' });
    expect(rejection(await session.apply(events[2] as SimulatedOcppEvent))).toBe('SESSION_CLOSED');
  });
});

describe('contract: outputs equal the frozen SPEC 00 golden vectors', () => {
  it('produces readings and charges identical to the fixture session and vectors.json', async () => {
    const outcomes = accepted(await applyAll(goldenSession(), goldenEvents()));
    const golden = buildGoldenSession();
    const vectors = readFixtureJson('vectors.json') as {
      readings: { readingId: string; readingDigest: string; evidenceDigest: string; meterSignatureB64: string }[];
    };
    outcomes.forEach((o, i) => {
      expect(MeterReadingSchema.parse(o.reading)).toEqual(o.reading);
      expect(MeasurementChargeSchema.parse(o.charge)).toEqual(o.charge);
      expect(o.reading).toEqual(golden.readings[i]);
      expect(o.charge).toEqual(golden.charges[i]);
      expect(o.charge.readingDigest).toBe(vectors.readings[i]?.readingDigest);
      expect(o.charge.evidenceDigest).toBe(vectors.readings[i]?.evidenceDigest);
      expect(o.reading.signatureB64).toBe(vectors.readings[i]?.meterSignatureB64);
    });
  });
});

describe('F1 source signature', () => {
  it('F1-A rejects one tampered source byte with INVALID_METER_SIGNATURE and no mutation', async () => {
    const session = goldenSession();
    const events = goldenEvents();
    await applyAll(session, events.slice(0, 2));
    const tampered = clone(events[2] as SimulatedOcppEvent);
    const bytes = base64ToBytes(signedPart(tampered).rawPayloadB64);
    const at = new TextDecoder().decode(bytes).indexOf('10500');
    bytes[at + 2] = '6'.charCodeAt(0); // meterEndWh 10500 -> 10600, signature kept
    signedPart(tampered).rawPayloadB64 = bytesToBase64(bytes);
    expect(rejection(await session.apply(tampered))).toBe('INVALID_METER_SIGNATURE');
    const rest = accepted(await applyAll(session, events.slice(2)));
    expect(rest.map((o) => o.charge.cumulativeChargeBaseUnits)).toEqual(['2000000', '3000000']);
  });

  it('F1-B rejects a valid signature from an untrusted key under a pinned key ID', async () => {
    const outcomes = await applyAll(goldenSession(), goldenEvents(untrustedSigner).slice(0, 2));
    expect(rejection(outcomes[1])).toBe('INVALID_METER_SIGNATURE');
  });

  it('F1-B rejects a key ID absent from the trusted registry', async () => {
    const outcomes = await applyAll(goldenSession(), goldenEvents({ ...untrustedSigner, keyId: 'rogue-meter' }).slice(0, 2));
    expect(rejection(outcomes[1])).toBe('UNKNOWN_METER_KEY');
  });

  it('rejects non-base64 source bytes', async () => {
    const session = goldenSession();
    const events = goldenEvents();
    await session.apply(events[0] as SimulatedOcppEvent);
    const bad = clone(events[1] as SimulatedOcppEvent);
    signedPart(bad).rawPayloadB64 = 'not base64!';
    expect(rejection(await session.apply(bad))).toBe('INVALID_SOURCE_BYTES');
  });
});

describe('F3 replay, envelope and continuity', () => {
  it('F3-A rejects a re-submitted r-002 with DUPLICATE_READING and keeps the cumulative', async () => {
    const session = goldenSession();
    const events = goldenEvents();
    await applyAll(session, events.slice(0, 3));
    expect(rejection(await session.apply(events[2] as SimulatedOcppEvent))).toBe('DUPLICATE_READING');
    const last = accepted(await applyAll(session, events.slice(3)));
    expect(last[0]?.charge.cumulativeChargeBaseUnits).toBe('3000000');
  });

  it.each([
    ['meter total', (e: SimulatedOcppEvent) => { (e.meterValue[0]!.sampledValue[0]!).value = 10300; }],
    ['transaction ID', (e: SimulatedOcppEvent) => { e.transactionInfo.transactionId = 'ev-session-999'; }],
    ['reading ID', (e: SimulatedOcppEvent) => { signedPart(e).readingId = 'r-009'; }],
    ['timestamp', (e: SimulatedOcppEvent) => { e.timestamp = '2026-10-25T09:01:30.000Z'; }],
  ])('F3-B rejects an envelope whose %s disagrees with the signed payload', async (_label, mutate) => {
    const session = goldenSession();
    const events = goldenEvents();
    await session.apply(events[0] as SimulatedOcppEvent);
    const tampered = clone(events[1] as SimulatedOcppEvent);
    mutate(tampered);
    expect(rejection(await session.apply(tampered))).toBe('SIGNED_PAYLOAD_MISMATCH');
  });

  it('F3-B rejects a signed payload from another machine', async () => {
    const outcomes = await applyAll(goldenSession({ machineId: 'sim-charger-02' }), goldenEvents().slice(0, 2));
    expect(rejection(outcomes[1])).toBe('SIGNED_PAYLOAD_MISMATCH');
  });

  it('F3-C rejects a counter gap (next interval starts at 10400 instead of 10250)', async () => {
    const session = goldenSession();
    const charger = goldenCharger();
    const [first, second] = inputs.intervals;
    await applyAll(session, [charger.started(), charger.interval(first!)]);
    const gap = charger.interval({ ...second!, meterStartWh: '10400', meterEndWh: '10650' });
    expect(rejection(await session.apply(gap))).toBe('COUNTER_GAP');
  });

  it('F3-C rejects overlapping interval times with INVALID_INTERVAL', async () => {
    const session = goldenSession();
    const charger = goldenCharger();
    const [first, second] = inputs.intervals;
    await applyAll(session, [charger.started(), charger.interval(first!)]);
    const overlap = charger.interval({ ...second!, intervalStart: '2026-10-25T09:00:30.000Z' });
    expect(rejection(await session.apply(overlap))).toBe('INVALID_INTERVAL');
  });

  it('rejects a decreasing counter with NON_MONOTONIC_COUNTER', async () => {
    const session = goldenSession();
    const charger = goldenCharger();
    await session.apply(charger.started());
    const backwards = charger.interval({ ...inputs.intervals[0]!, meterEndWh: '9990' });
    expect(rejection(await session.apply(backwards))).toBe('NON_MONOTONIC_COUNTER');
  });

  it('rejects a stale interval with OUT_OF_ORDER', async () => {
    const session = goldenSession();
    const charger = goldenCharger();
    const [first, second] = inputs.intervals;
    await applyAll(session, [charger.started(), charger.interval(first!), charger.interval(second!)]);
    const stale = charger.interval({ ...first!, readingId: 'r-001b', meterStartWh: '10500', meterEndWh: '10750' });
    expect(rejection(await session.apply(stale))).toBe('OUT_OF_ORDER');
  });

  it('rejects a reading before Started with OUT_OF_ORDER', async () => {
    const outcomes = await applyAll(goldenSession(), goldenEvents().slice(1, 2));
    expect(rejection(outcomes[0])).toBe('OUT_OF_ORDER');
  });
});

describe('F3-D tariff and integer handling', () => {
  it('rejects a non-integer transport Wh value with UNSUPPORTED_EVENT', async () => {
    const session = goldenSession();
    const event = clone(goldenEvents()[0] as SimulatedOcppEvent);
    event.meterValue[0]!.sampledValue[0]!.value = 10000.5;
    expect(rejection(await session.apply(event))).toBe('UNSUPPORTED_EVENT');
  });

  it('rejects non-integer signed Wh with INVALID_SOURCE_BYTES', async () => {
    const session = goldenSession();
    const events = goldenEvents();
    await session.apply(events[0] as SimulatedOcppEvent);
    const event = clone(events[1] as SimulatedOcppEvent);
    const payload = JSON.parse(new TextDecoder().decode(base64ToBytes(signedPart(event).rawPayloadB64)));
    const raw = utf8Bytes(canonicalize({ ...payload, meterEndWh: '10250.5' }));
    signedPart(event).rawPayloadB64 = bytesToBase64(raw);
    signedPart(event).signatureB64 = bytesToBase64(trustedSigner.sign(raw));
    expect(rejection(await session.apply(event))).toBe('INVALID_SOURCE_BYTES');
  });

  it('rejects a tariff version change mid-session with TARIFF_CHANGED', async () => {
    let tariff: TariffSnapshot = goldenTariff;
    const session = goldenSession({ currentTariff: () => tariff });
    const events = goldenEvents();
    await applyAll(session, events.slice(0, 2));
    const fields = { ...goldenTariff, pricePerKwhBaseUnits: '5000000' };
    tariff = { ...fields, versionDigest: computeTariffVersionDigest(fields) };
    expect(rejection(await session.apply(events[2] as SimulatedOcppEvent))).toBe('TARIFF_CHANGED');
  });

  it('rejects readings outside the tariff validity window with TARIFF_NOT_ACTIVE', async () => {
    const fields = { ...goldenTariff, validUntil: '2026-10-25T09:01:30.000Z' };
    const expiring = { ...fields, versionDigest: computeTariffVersionDigest(fields) };
    const outcomes = await applyAll(goldenSession({ currentTariff: () => expiring }), goldenEvents());
    expect(accepted(outcomes)).toHaveLength(1);
    expect(rejection(outcomes[2])).toBe('TARIFF_NOT_ACTIVE');
  });

  it('rejects a tariff whose versionDigest does not recompute', async () => {
    const forged = { ...goldenTariff, pricePerKwhBaseUnits: '1' };
    const outcomes = await applyAll(goldenSession({ currentTariff: () => forged }), goldenEvents().slice(0, 1));
    expect(rejection(outcomes[0])).toBe('TARIFF_NOT_ACTIVE');
  });

  it('rejects a tariff for an unexpected asset', async () => {
    const outcomes = await applyAll(
      goldenSession({ expectedAssetSac: 'CAEMNVZ7LHUUXWJQ2K36JHXRMUHG2FPXFQYKXW2VUINCXSZMCXPMQKN7' }),
      goldenEvents().slice(0, 1),
    );
    expect(rejection(outcomes[0])).toBe('TARIFF_NOT_ACTIVE');
  });

  it('reports positive usage that rounds to zero value as ZERO_VALUE_INCREMENT', async () => {
    const fields = { ...goldenTariff, pricePerKwhBaseUnits: '1' };
    const cheap = { ...fields, versionDigest: computeTariffVersionDigest(fields) };
    const outcomes = await applyAll(goldenSession({ currentTariff: () => cheap }), goldenEvents().slice(0, 2));
    expect(rejection(outcomes[1])).toBe('ZERO_VALUE_INCREMENT');
  });
});

describe('simulator boundary', () => {
  it('signs only inside the simulator: the session holds public keys, the signer holds the key', () => {
    const event = goldenEvents()[1] as SimulatedOcppEvent;
    expect(signedPart(event).signerKeyId).toBe(trustedSigner.keyId);
    expect(JSON.stringify(event)).not.toMatch(/secret|seed|private/i);
  });
});
