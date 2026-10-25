import { utc, type RealRunView } from '../bundle.ts';
import { LayerBadge, SectionHeader, StatusBadge, useTechnical } from './ui.tsx';

/**
 * Section 7, the Verify page (01.1 P0 Must 4): the eight independent checks as `pnpm demo` captured them (SPEC 05 D14).
 * The verdict is displayed, never recomputed or upgraded: NOT_AVAILABLE and FAIL keep their own icon and words.
 */
export function Verify({ run }: { run: RealRunView }) {
  const technical = useTechnical();
  const { overall, checks, mode, at } = run.verification;
  return (
    <section id="verify" className="section" aria-labelledby="verify-title">
      <SectionHeader id="verify" eyebrow="7 · Independent auditor" title="Eight checks, recomputed from public evidence" layer="BOTH">
        The auditor holds no keys and trusts no stored “verified” flag. It recomputes every fingerprint and signature from the evidence package and
        then asks the public ledger what really happened.
      </SectionHeader>

      <div className={`verdict verdict-${overall.status.toLowerCase()}`} role="status" aria-label="Auditor verdict">
        <StatusBadge status={overall.status} label={`AUDITOR VERDICT: ${overall.status}`} large />
        <p>{overall.plain}</p>
        <p className="muted small">
          Captured {utc(at, true)} by <code>pnpm demo</code>, {mode === 'LIVE' ? 'reading Stellar Testnet live (read-only)' : 'OFFLINE: the ledger was not queried, so the payment is not confirmed'}.
          {technical ? (
            <>
              {' '}
              Reason code <code>{overall.reasonCode}</code>.
            </>
          ) : null}
        </p>
      </div>

      <ol className="checks" aria-label="Verification checks">
        {checks.map((check) => (
          <li key={check.id} className={`check check-${check.status.toLowerCase()}`} data-check={check.id}>
            <div className="check-head">
              <StatusBadge status={check.status} />
              <span className="check-id">{check.id.slice(0, 3)}</span>
              <h3>{check.title}</h3>
              <LayerBadge layer={check.layer} />
            </div>
            <p className="check-question">{check.question}</p>
            <p className={check.status === 'PASS' ? 'check-plain muted' : 'check-plain'}>{check.plain}</p>
            <details open={technical}>
              <summary>How it was checked</summary>
              <p>
                <code>{check.id}</code> · <code>{check.reasonCode}</code>
              </p>
              <p className="check-details">{check.details}</p>
            </details>
          </li>
        ))}
      </ol>
    </section>
  );
}
