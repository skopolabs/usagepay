import {
  TEST_ONLY_METER_KEY,
  TEST_ONLY_UNTRUSTED_METER_KEY,
  TRUSTED_METER_KEYS,
  buildTariff,
  loadGoldenInputs,
  type TestKey,
} from '@usagepay/fixtures';
import type { TariffSnapshot } from '@usagepay/contracts';
import {
  createMeteringSession,
  createSimulatedCharger,
  type MeterSigner,
  type MeteringOutcome,
  type MeteringSessionConfig,
  type SimulatedCharger,
  type SimulatedOcppEvent,
} from '../src/index.js';

export const inputs = loadGoldenInputs();
export const goldenTariff: TariffSnapshot = buildTariff(inputs);

export function signerFrom(key: TestKey, keyId = inputs.meter.signerKeyId): MeterSigner {
  return { keyId, sign: (bytes) => key.sign(bytes) };
}

export const trustedSigner = signerFrom(TEST_ONLY_METER_KEY);
export const untrustedSigner = signerFrom(TEST_ONLY_UNTRUSTED_METER_KEY);

export function goldenCharger(signer: MeterSigner = trustedSigner): SimulatedCharger {
  return createSimulatedCharger({
    sessionId: inputs.session.sessionId,
    machineId: inputs.session.machineId,
    startedAt: inputs.session.startedAt,
    meterStartWh: inputs.session.meterStartWh,
    signer,
  });
}

/** Started + the three golden intervals (the last one as `Ended`). */
export function goldenEvents(signer: MeterSigner = trustedSigner): SimulatedOcppEvent[] {
  const charger = goldenCharger(signer);
  return [
    charger.started(),
    ...inputs.intervals.map((interval, index) =>
      charger.interval({ ...interval, final: index === inputs.intervals.length - 1 }),
    ),
  ];
}

export function goldenSession(overrides: Partial<MeteringSessionConfig> = {}) {
  return createMeteringSession({
    machineId: inputs.session.machineId,
    expectedAssetSac: goldenTariff.assetSac,
    trustedMeterKeys: TRUSTED_METER_KEYS,
    currentTariff: () => goldenTariff,
    ...overrides,
  });
}

export async function applyAll(session: { apply(e: SimulatedOcppEvent): Promise<MeteringOutcome> }, events: SimulatedOcppEvent[]) {
  const outcomes: MeteringOutcome[] = [];
  for (const event of events) outcomes.push(await session.apply(event));
  return outcomes;
}

export function rejection(outcome: MeteringOutcome | undefined): string {
  return outcome?.kind === 'REJECTED' ? outcome.reasonCode : `not rejected (${outcome?.kind})`;
}

/** Deep clone so a test can tamper with one event without touching the others. */
export function clone<T>(value: T): T {
  return structuredClone(value);
}
