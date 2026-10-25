import type {
  AuthorizedIncrement,
  EvidenceE0,
  EvidenceE1,
  MeasurementCharge,
  MeterReading,
  TariffSnapshot,
} from '@usagepay/contracts';
import type { PayerRefusalCode } from './codes.js';

export type AuthorizeResult =
  | { readonly kind: 'AUTHORIZED'; readonly increment: AuthorizedIncrement }
  | { readonly kind: 'REJECTED'; readonly reasonCode: PayerRefusalCode; readonly details: string }
  | { readonly kind: 'PENDING'; readonly reasonCode: string; readonly details: string };

/**
 * SPEC 02 §3. `AUTHORIZED` means both the payer evidence approval and the SDK's native acceptance passed; it never
 * means merely "the payer signed something".
 */
export interface PayerAuthorizationPort {
  authorize(input: {
    reading: MeterReading;
    charge: MeasurementCharge;
    tariff: TariffSnapshot;
    channelId: string;
  }): Promise<AuthorizeResult>;
}

export type CloseResult =
  | { readonly kind: 'OBSERVED'; readonly e1: EvidenceE1 }
  | { readonly kind: 'PENDING'; readonly reasonCode: string; readonly details: string }
  | { readonly kind: 'REJECTED'; readonly reasonCode: string; readonly details: string };

/** SPEC 02 §3. `OBSERVED` means RPC was queried and E1 holds its actual status; only `SUCCESS` may be reported as settled. */
export interface ChannelSettlementPort {
  closeLatest(input: { channelId: string; e0: EvidenceE0 }): Promise<CloseResult>;
}
