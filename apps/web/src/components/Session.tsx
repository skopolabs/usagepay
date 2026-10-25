import { useState } from 'react';
import { formatAmount, formatEnergy, short } from '@usagepay/demo/format';
import type { DemoBundle, RealRunView } from '../bundle.ts';
import { Hash, SectionHeader, useTechnical } from './ui.tsx';
import { Timeline } from './Timeline.tsx';

/** Section 3: the simulated charger, one row per signed reading decoded from the exact bytes in E0. */
export function Session({ run }: { run: RealRunView }) {
  const technical = useTechnical();
  const [selected, setSelected] = useState(run.meter.length - 1);
  const row = run.meter[selected];
  return (
    <section id="session" className="section" aria-labelledby="session-title">
      <SectionHeader id="session" eyebrow="3 · Metered usage · demo: EV charging" title="The meter measures and signs every reading" layer="OFF_CHAIN">
        Each minute the meter, here an EV charger, reports its register and signs the exact bytes with its meter key. Change one digit and the
        signature no longer matches (scenario F1). This demo meters energy; any service a machine can measure follows the same steps.
      </SectionHeader>
      <div className="session">
        <div className="charger" aria-label="Simulated charger display">
          <div className="charger-top">
            <span className="badge-sim">SIMULATED meter</span>
            <span className="muted">{row?.certification === 'simulated' ? 'test key, not certified' : row?.certification}</span>
          </div>
          {row === undefined ? (
            <p>No readings recorded.</p>
          ) : (
            <dl className="charger-screen">
              <div>
                <dt>Register</dt>
                <dd>
                  {row.meterEndWh} <small>Wh</small>
                </dd>
              </div>
              <div>
                <dt>Delivered</dt>
                <dd>{formatEnergy(row.cumulativeWh)}</dd>
              </div>
              <div className="charger-price">
                <dt>Price</dt>
                <dd>
                  {run.tariff.pricePerKwh} <small>/ kWh</small>
                </dd>
              </div>
              <div className="charger-total">
                <dt>Running total</dt>
                <dd>{formatAmount(row.cumulativeChargeBaseUnits)}</dd>
              </div>
            </dl>
          )}
          <p className="charger-sign">
            Signed by meter key <code>{row?.signerKeyId}</code> <Hash value={run.parties.meterKey} />
          </p>
        </div>

        <div className="readings">
          <table>
            <caption>Signed readings ({run.tariff.tariffId})</caption>
            <thead>
              <tr>
                <th scope="col">Reading</th>
                <th scope="col">Time (UTC)</th>
                <th scope="col">Register (Wh)</th>
                <th scope="col">Energy</th>
                <th scope="col">Running total</th>
                {technical ? <th scope="col">Voucher · receipt</th> : null}
              </tr>
            </thead>
            <tbody>
              {run.meter.map((r, index) => (
                <tr key={r.readingId} className={index === selected ? 'selected' : ''}>
                  <th scope="row">
                    <button type="button" className="row-select" onClick={() => setSelected(index)} aria-pressed={index === selected}>
                      {r.readingId}
                    </button>
                  </th>
                  <td>
                    {r.intervalStart.slice(11, 16)}–{r.intervalEnd.slice(11, 16)}
                  </td>
                  <td>
                    {r.meterStartWh} → {r.meterEndWh}
                  </td>
                  <td>+{formatEnergy(r.deltaWh)}</td>
                  <td className="num">{formatAmount(r.cumulativeChargeBaseUnits)}</td>
                  {technical ? (
                    <td>
                      <code title={r.voucherDigest}>{short(r.voucherDigest)}</code> · <code title={r.receiptNonce}>{short(r.receiptNonce)}</code>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">
            Price list valid {run.tariff.validFrom.slice(0, 10)} to {run.tariff.validUntil === 'open-ended' ? 'open-ended' : run.tariff.validUntil.slice(0, 10)}. Amounts are
            integers in USDC base units; the display rounds nothing.
          </p>
        </div>
      </div>
    </section>
  );
}

/** Section 4: the recorded flow on the swimlane, with the off-chain voucher counter and the E0 stamp. */
export function Flow({ bundle, run, toggleSignal }: { bundle: DemoBundle; run: RealRunView; toggleSignal: number }) {
  return (
    <section id="flow" className="section" aria-labelledby="flow-title">
      <SectionHeader id="flow" eyebrow="4 · Approval and vouchers" title="Paid step by step, without touching the blockchain each time" layer="BOTH">
        For every reading the fleet checks the price and its budget, signs a Stellar payment voucher for the running total and a receipt tying that
        voucher to the reading. The station accepts only if the receipt matches. Vouchers stay off-chain; only the last one is ever submitted.
      </SectionHeader>
      <Timeline events={run.story} actors={bundle.actors} label="Recorded events of the Testnet run" replay={{ runId: run.runId, recordedAt: run.recordedAt }} toggleSignal={toggleSignal} />
    </section>
  );
}
