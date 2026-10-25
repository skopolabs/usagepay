import { ed25519 } from '@noble/curves/ed25519.js';
import {
  bytesToBase64,
  encodeSimMeterPayload,
  publicKeyToAccountId,
  type SimMeterPayload,
} from '@usagepay/contracts';
import type { MeterSigner, SimulatedOcppEvent } from './types.js';

/**
 * SPEC 01 simulated charger. It is the only component that signs meter data: it JCS-encodes the §3.2 payload,
 * signs those exact bytes with the injected meter key and wraps them in an OCPP-shaped event.
 */
export interface SimulatedChargerConfig {
  readonly sessionId: string;
  readonly machineId: string;
  readonly startedAt: string;
  /** Absolute register value at session start, as a decimal string. */
  readonly meterStartWh: string;
  readonly signer: MeterSigner;
}

export interface SimulatedInterval {
  readonly readingId: string;
  readonly observedAt: string;
  readonly intervalStart: string;
  readonly intervalEnd: string;
  readonly meterStartWh: string;
  readonly meterEndWh: string;
  /** Emit as `Ended` (terminal signed reading) instead of `Updated`. */
  readonly final?: boolean;
}

export interface SimulatedCharger {
  started(): SimulatedOcppEvent;
  interval(interval: SimulatedInterval): SimulatedOcppEvent;
  /** `Ended` without a reading: closes the session when the final reading was already sent. */
  ended(at?: string): SimulatedOcppEvent;
}

export function createSimulatedCharger(config: SimulatedChargerConfig): SimulatedCharger {
  const envelope = (eventType: SimulatedOcppEvent['eventType'], timestamp: string, registerWh: string) => ({
    eventType,
    timestamp,
    transactionInfo: { transactionId: config.sessionId },
    meterValue: [
      {
        timestamp,
        sampledValue: [
          {
            measurand: 'Energy.Active.Import.Register' as const,
            unitOfMeasure: { unit: 'Wh' as const },
            // Transport carries a JSON number like OCPP; the signed payload keeps the exact decimal string.
            value: Number(registerWh),
          },
        ],
      },
    ],
  });
  let lastRegisterWh = config.meterStartWh;
  let lastAt = config.startedAt;

  return {
    started: () => envelope('Started', config.startedAt, config.meterStartWh),
    interval(interval) {
      const payload: SimMeterPayload = {
        schema: 'usagepay.sim-meter-payload.v1',
        domain: 'ev.ocpp2x',
        sessionId: config.sessionId,
        machineId: config.machineId,
        readingId: interval.readingId,
        observedAt: interval.observedAt,
        intervalStart: interval.intervalStart,
        intervalEnd: interval.intervalEnd,
        meterStartWh: interval.meterStartWh,
        meterEndWh: interval.meterEndWh,
        unit: 'Wh',
      };
      const raw = encodeSimMeterPayload(payload);
      lastRegisterWh = interval.meterEndWh;
      lastAt = interval.observedAt;
      return {
        ...envelope(interval.final === true ? 'Ended' : 'Updated', interval.observedAt, interval.meterEndWh),
        usagepaySimulator: {
          readingId: interval.readingId,
          rawPayloadB64: bytesToBase64(raw),
          signatureB64: bytesToBase64(config.signer.sign(raw)),
          signerKeyId: config.signer.keyId,
        },
      };
    },
    ended: (at = lastAt) => envelope('Ended', at, lastRegisterWh),
  };
}

/** A fresh random meter key for a demo run. The returned public key goes into the verifier's pinned registry. */
export function createRandomMeterSigner(keyId: string): MeterSigner & { readonly publicKey: Uint8Array; readonly accountId: string } {
  const secretKey = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(secretKey);
  return { keyId, publicKey, accountId: publicKeyToAccountId(publicKey), sign: (message) => ed25519.sign(message, secretKey) };
}
