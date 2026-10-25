import type { DemoBundle } from '../bundle.ts';
import { ActorIcon, LayerBadge, SectionHeader, StatusBadge } from './ui.tsx';

/** The kicker above the first sentence (01.2 §0.1). */
export const KICKER = 'Infrastructure for the machine economy.';

/** The first sentence of the demo (01.2 §0.1): the category first, the EV use case second. */
export const POSITIONING = 'UsagePay enables verifiable machine-to-machine payments for metered services on Stellar.';

/** Illustrative categories, not built adapters (01.2 §0.1); the demo runs the energy adapter only. */
const SERVICES = ['Energy', 'Compute time', 'Connectivity', 'Equipment hours', 'Water'] as const;

/** What every UsagePay payment carries, read left to right in the hero panel (the five links UsagePay adds, section 1). */
const PROOF: readonly (readonly [string, string])[] = [
  ['Measurement', 'Signed by the meter'],
  ['Price', 'Replayable to the base unit'],
  ['Approval', 'Signed by the payer'],
  ['Settlement', 'One Stellar transaction'],
  ['Verification', 'Anyone, with no keys'],
];

/** Section 0: what the service is, nothing else; the demo use case is introduced with the actors. A bundle without a real run says so here. */
export function Overview({ bundle }: { bundle: DemoBundle }) {
  const run = bundle.realRun;
  return (
    <section id="overview" className="section hero" aria-labelledby="overview-title">
      <div className="hero-text">
        <p className="kicker">{KICKER}</p>
        <h1 id="overview-title" tabIndex={-1}>
          {POSITIONING.slice(0, -1)}
          <span className="dot-end">.</span>
        </h1>
        <p className="hero-lead">
          Every payment carries its proof: the signed measurement, the price applied, the payer&apos;s approval and the Stellar settlement,
          checkable by anyone.
        </p>
        <p className="hero-actions">
          {run.status === 'MISSING' ? (
            <a className="button button-primary" href="#scenarios">
              See the scenarios <span aria-hidden="true">→</span>
            </a>
          ) : (
            <>
              <a className="button button-primary" href="#flow">
                Watch the replay <span aria-hidden="true">→</span>
              </a>
              <a className="button" href="#verify">
                See the auditor <span aria-hidden="true">↘</span>
              </a>
            </>
          )}
        </p>
        {run.status === 'MISSING' ? (
          <div className="banner banner-bad" role="status">
            <StatusBadge status="NOT_AVAILABLE" label="No real Testnet run" />
            <p>
              This bundle holds no captured Stellar Testnet run ({run.reason}). The scenarios below still run real code against a simulated ledger; no
              Testnet payment is shown.
            </p>
          </div>
        ) : null}
        <p className="demo-result">
          <span>Demo self-check</span>
          <StatusBadge status={bundle.result.status} />
          <span className="muted">{bundle.result.detail}</span>
        </p>
      </div>

      <figure className="proof-panel" aria-label="What every payment carries">
        <p className="proof-head">
          <span className="proof-dot" aria-hidden="true" />
          UsagePay / payment proof
        </p>
        <p className="proof-title">One payment, its evidence attached</p>
        <dl className="proof-rows">
          {PROOF.map(([what, how]) => (
            <div key={what}>
              <dt>{what}</dt>
              <dd>{how}</dd>
            </div>
          ))}
        </dl>
        <figcaption className="proof-foot">
          Off-chain vouchers <span aria-hidden="true">→</span> one Stellar settlement
        </figcaption>
      </figure>
    </section>
  );
}

/** Section 1: the problem in three boxes and why Stellar MPP alone does not close it (01.2 §0.1). Static copy within the SPEC 04 limits. */
export function Gap() {
  return (
    <section id="gap" className="section" aria-labelledby="gap-title">
      <SectionHeader id="gap" eyebrow="1 · The gap" title="A valid payment does not say what it paid for">
        Today the meter, the payer and the ledger each keep their own record. Nobody can prove which payment matched which measurement.
      </SectionHeader>
      <div className="gap">
        <div className="gap-box">
          <ActorIcon actor="meter" />
          <h3>The meter</h3>
          <p>Knows how much was used.</p>
        </div>
        <span className="gap-link" aria-hidden="true">?</span>
        <div className="gap-box">
          <ActorIcon actor="fleet" />
          <h3>The payer</h3>
          <p>Knows what it agreed to pay.</p>
        </div>
        <span className="gap-link" aria-hidden="true">?</span>
        <div className="gap-box">
          <ActorIcon actor="stellar" />
          <h3>The ledger</h3>
          <p>Knows that money moved.</p>
        </div>
      </div>

      <div className="mpp-gap" aria-labelledby="mpp-gap-title">
        <h3 id="mpp-gap-title">Why Stellar MPP alone is not enough</h3>
        <div className="mpp-columns">
          <div className="mpp-col mpp-proves">
            <p className="mpp-col-title">MPP proves</p>
            <ul>
              <li>How much the payer authorized: it signs a running total for one channel.</li>
              <li>That the money settled: the channel closes on Stellar.</li>
            </ul>
          </div>
          <div className="mpp-col mpp-cannot">
            <p className="mpp-col-title">MPP cannot prove: for what?</p>
            <ul>
              <li>A voucher carries no reading, no unit and no price.</li>
              <li>The channel contract pays any amount the payer signed. It never sees the meter.</li>
              <li>So any usage log can sit next to a valid payment, and nobody can prove they belong together.</li>
            </ul>
          </div>
        </div>
        <div className="mpp-adds-box">
          <p className="mpp-adds-title">
            <strong>UsagePay adds the missing link</strong>, on top of MPP and without a new contract:
          </p>
          <ol className="mpp-adds">
            <li>Signed readings are checked before anyone pays.</li>
            <li>Pricing can be replayed by anyone, to the exact base unit.</li>
            <li>A payer-signed receipt binds each voucher to its exact evidence, channel and network.</li>
            <li>Evidence is sealed before settlement and linked to the transaction after it.</li>
            <li>An independent auditor re-checks everything and holds no keys.</li>
          </ol>
        </div>
      </div>

      <div className="fits" aria-labelledby="fits-title">
        <h3 id="fits-title">Fits what is already deployed</h3>
        <ul className="fits-list">
          <li>
            <strong>No new hardware.</strong> Built to read the meter data that existing standards already carry; in EV charging, OCPP with OCMF
            signed readings. No new device, no firmware change.
          </li>
          <li>
            <strong>No new payment protocol.</strong> Payments use Stellar MPP and its existing one-way channel contract, unchanged. No new
            contract, no fork.
          </li>
          <li>
            <strong>Beside existing systems.</strong> Charger management, billing and roaming keep their role. UsagePay adds the evidence that links
            their records to the payment.
          </li>
        </ul>
        <p className="muted small">
          In this demo the meter is simulated: OCPP-shaped readings signed with a test key, not certified and not OCPP or OCMF conformant.
        </p>
      </div>
    </section>
  );
}

const SIDE: Record<string, { readonly layer: 'OFF_CHAIN' | 'ON_CHAIN' | 'BOTH'; readonly note: string }> = {
  meter: { layer: 'OFF_CHAIN', note: 'Signs readings' },
  fleet: { layer: 'OFF_CHAIN', note: 'Signs vouchers and receipts' },
  station: { layer: 'BOTH', note: 'Checks off-chain, closes on-chain' },
  stellar: { layer: 'ON_CHAIN', note: 'Public ledger' },
  auditor: { layer: 'BOTH', note: 'Reads both, holds no keys' },
};

/** Section 2: the five actors, from `bundle.actors`, then the demo use case that names them (EV charger, fleet, station). */
export function Actors({ bundle }: { bundle: DemoBundle }) {
  return (
    <section id="actors" className="section" aria-labelledby="actors-title">
      <SectionHeader id="actors" eyebrow="2 · Who is involved" title="Five parties, each with one job">
        Each party is named by its role first and by its part in the demo second.
      </SectionHeader>
      <ul className="actors">
        {Object.entries(bundle.actors).map(([id, actor]) => {
          const side = SIDE[id];
          return (
            <li key={id} className={`actor-card actor-card-${id}`}>
              <ActorIcon actor={id} />
              <h3>{actor.name}</h3>
              <p>{actor.role}</p>
              {side === undefined ? null : (
                <p className="actor-side">
                  {side.layer === 'BOTH' ? (
                    <>
                      <LayerBadge layer="OFF_CHAIN" compact /> <LayerBadge layer="ON_CHAIN" compact />
                    </>
                  ) : (
                    <LayerBadge layer={side.layer} compact />
                  )}
                  <span className="muted">{side.note}</span>
                </p>
              )}
            </li>
          );
        })}
      </ul>
      <aside className="use-case" aria-label="Demo use case">
        <div>
          <p className="use-case-tag">Demo use case · EV charging</p>
          <p>
            We show it with an electric vehicle charging, because everyone understands a charger and a kilowatt-hour: the charger signs every reading,
            the fleet pays the station step by step with off-chain Stellar vouchers, and one Stellar transaction settles the total. The same flow fits
            any service a machine can measure.
          </p>
        </div>
        <ul className="use-case-list" aria-label="Metered services the same flow fits">
          {SERVICES.map((service) => (
            <li key={service} className={service === 'Energy' ? 'use-case-shown' : undefined}>
              {service}
              {service === 'Energy' ? <span className="muted"> · shown here</span> : null}
            </li>
          ))}
        </ul>
      </aside>
    </section>
  );
}
