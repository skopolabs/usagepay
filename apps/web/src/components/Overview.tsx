import { formatAmount, formatEnergy } from '@usagepay/demo/format';
import { progressOf, utc, type DemoBundle } from '../bundle.ts';
import { ActorIcon, LayerBadge, SectionHeader, StatusBadge } from './ui.tsx';

/** Section 0: value proposition, the honest replay banner and the headline figures, all read from the bundle. */
export function Overview({ bundle }: { bundle: DemoBundle }) {
  const run = bundle.realRun;
  return (
    <section id="overview" className="section hero" aria-labelledby="overview-title">
      <p className="eyebrow">UsagePay · HackMeridian P0 · Stellar Testnet</p>
      <h1 id="overview-title" tabIndex={-1}>
        Pay for every kilowatt-hour, and prove it.
      </h1>
      <p className="hero-lead">
        An electric vehicle charges. The charger signs every meter reading. The fleet wallet pays the station step by step with off-chain Stellar
        vouchers, each tied to its reading by a signed receipt. One Stellar transaction settles the total, and an independent auditor re-checks
        everything from public evidence.
      </p>

      {run.status === 'MISSING' ? (
        <div className="banner banner-bad" role="status">
          <StatusBadge status="NOT_AVAILABLE" label="No real Testnet run" />
          <p>
            This bundle holds no captured Stellar Testnet run ({run.reason}). The scenarios below still run real code against a simulated ledger; no
            Testnet payment is shown.
          </p>
        </div>
      ) : (
        <div className="banner banner-replay" role="status">
          <p className="banner-title">
            <strong>REPLAY</strong> of a real Stellar Testnet run · <code>{run.runId}</code> · recorded {utc(run.recordedAt)}
          </p>
          <p>Nothing is paid again now. The page shows what happened, step by step, and how an independent auditor checked it.</p>
          <p className="banner-verdict">
            <StatusBadge status={run.verification.overall.status} />
            <span>
              Auditor verdict captured {utc(run.verification.at)}, {run.verification.mode === 'LIVE' ? 'reading Stellar Testnet live' : 'offline'}. {run.verification.overall.plain}
            </span>
          </p>
        </div>
      )}

      {run.status === 'MISSING' ? null : <Figures bundle={bundle} />}

      <p className="demo-result">
        <span>Demo self-check</span>
        <StatusBadge status={bundle.result.status} />
        <span className="muted">{bundle.result.detail}</span>
      </p>
    </section>
  );
}

function Figures({ bundle }: { bundle: DemoBundle }) {
  const run = bundle.realRun;
  if (run.status === 'MISSING') return null;
  const last = run.meter.at(-1);
  const progress = progressOf(run.story);
  const passed = run.verification.checks.filter((c) => c.status === 'PASS').length;
  return (
    <dl className="figures">
      <div>
        <dt>Energy delivered</dt>
        <dd>{last === undefined ? '—' : formatEnergy(last.cumulativeWh)}</dd>
        <span className="figure-note">{run.meter.length} signed readings</span>
      </div>
      <div>
        <dt>Paid to the station</dt>
        <dd>{formatAmount(run.settlement.settled)}</dd>
        <span className="figure-note">at {run.tariff.pricePerKwh} per kWh</span>
      </div>
      <div className="figure-flow">
        <dt>Payments</dt>
        <dd>
          {progress.vouchers} vouchers → {progress.transactions} transaction
        </dd>
        <span className="figure-note">
          <LayerBadge layer="OFF_CHAIN" /> → <LayerBadge layer="ON_CHAIN" />
        </span>
      </div>
      <div>
        <dt>Auditor checks</dt>
        <dd>
          {passed} / {run.verification.checks.length} PASS
        </dd>
        <span className="figure-note">recomputed, no keys held</span>
      </div>
    </dl>
  );
}

/** Section 1: the problem in three boxes. Static copy; it claims nothing beyond the SPEC 04 limits. */
export function Gap() {
  return (
    <section id="gap" className="section" aria-labelledby="gap-title">
      <SectionHeader id="gap" eyebrow="1 · The gap" title="Three systems that never talk to each other">
        Today the meter, the payment and the ledger each keep their own record. Nobody can prove which payment matched which measurement.
      </SectionHeader>
      <div className="gap">
        <div className="gap-box">
          <ActorIcon actor="meter" />
          <h3>The meter</h3>
          <p>Knows how much energy it delivered.</p>
        </div>
        <span className="gap-link" aria-hidden="true">?</span>
        <div className="gap-box">
          <ActorIcon actor="fleet" />
          <h3>The fleet payment</h3>
          <p>Knows what it agreed to pay.</p>
        </div>
        <span className="gap-link" aria-hidden="true">?</span>
        <div className="gap-box">
          <ActorIcon actor="stellar" />
          <h3>The ledger</h3>
          <p>Knows that money moved.</p>
        </div>
      </div>
      <p className="gap-answer">
        <strong>UsagePay ties them together with signatures.</strong> The meter signs each reading; the fleet signs a payment voucher and a separate
        receipt binding that voucher to that exact reading; the station gets paid on Stellar; the auditor re-checks every link.
      </p>
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

/** Section 2: the five actors, from `bundle.actors`. */
export function Actors({ bundle }: { bundle: DemoBundle }) {
  return (
    <section id="actors" className="section" aria-labelledby="actors-title">
      <SectionHeader id="actors" eyebrow="2 · Who is involved" title="Five parties, each with one job" />
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
                      <LayerBadge layer="OFF_CHAIN" /> <LayerBadge layer="ON_CHAIN" />
                    </>
                  ) : (
                    <LayerBadge layer={side.layer} />
                  )}
                  <span className="muted">{side.note}</span>
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
