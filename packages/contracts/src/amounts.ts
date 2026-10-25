import { DecimalStringSchema } from './primitives.js';

/** Watt-hours per kilowatt-hour; tariffs are priced per kWh while readings are integer Wh. */
export const WH_PER_KWH = 1000n;

/** Parses a validated DecimalString into a bigint; throws on any non-canonical integer spelling. */
export function decimalToBigInt(value: string): bigint {
  return BigInt(DecimalStringSchema.parse(value));
}

/** Formats a nonnegative bigint as a DecimalString. */
export function bigIntToDecimal(value: bigint): string {
  if (value < 0n) throw new RangeError(`amounts are nonnegative; got ${value}`);
  return DecimalStringSchema.parse(value.toString());
}

/**
 * SPEC 00 §6: `floor(cumulativeWh * pricePerKwhBaseUnits / 1000)`, rounded once on the cumulative total
 * (`rounding: 'floor_cumulative'`), never per interval.
 */
export function cumulativeChargeBaseUnits(cumulativeWh: bigint, pricePerKwhBaseUnits: bigint): bigint {
  if (cumulativeWh < 0n || pricePerKwhBaseUnits < 0n) throw new RangeError('energy and price must be nonnegative');
  return (cumulativeWh * pricePerKwhBaseUnits) / WH_PER_KWH;
}
