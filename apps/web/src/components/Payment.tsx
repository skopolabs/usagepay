import { formatAmount } from '@usagepay/demo/format';
import { depositOf, trimDecimal, units, type RealRunView } from '../bundle.ts';
import { CopyButton, ExternalLink, Hash, LayerBadge, SectionHeader, StatusBadge } from './ui.tsx';

/** Section 5: the single close transaction and where the money went, as observed on the ledger. */
export function Payment({ run }: { run: RealRunView }) {
  const ledger = run.ledger;
  const observed = ledger.status === 'OBSERVED' && ledger.tx.status !== 'NOT_FOUND' ? ledger : undefined;
  const withdraw = observed?.events.find((e) => e.name === 'withdraw');
  const refund = observed?.events.find((e) => e.name === 'refund');
  const deposit = depositOf(run);
  const vouchers = run.story.filter((e) => e.technical['event'] === 'payer.native.signed').length;
  const balances = run.settlement.balances;

  return (
    <section id="payment" className="section" aria-labelledby="payment-title">
      <SectionHeader id="payment" eyebrow="5 · One payment on Stellar" title={`${vouchers} vouchers → 1 transaction`} layer="ON_CHAIN">
        The station submits one close transaction carrying the highest voucher. The channel contract checks the fleet signature itself, pays the
        station and returns the unused deposit to the fleet.
      </SectionHeader>

      {observed === undefined ? (
        <div className="banner banner-wait" role="status">
          <StatusBadge status="NOT_AVAILABLE" label="Ledger not confirmed" />
          <p>
            {ledger.status === 'UNAVAILABLE' ? `The ledger could not be read when this bundle was made (${ledger.error}).` : 'The ledger has no record of this transaction.'} Showing
            the recorded close only; it is not confirmed here.
          </p>
        </div>
      ) : null}

      <div className="payment">
        <dl className="tx-card">
          <div>
            <dt>Close transaction</dt>
            <dd>
              <Hash value={run.settlement.closeTxHash} href={run.links.closeTx} />
            </dd>
          </div>
          <div>
            <dt>Status on the ledger</dt>
            <dd>
              {observed === undefined ? <StatusBadge status="NOT_AVAILABLE" label={`recorded ${run.settlement.recordedStatus}, not re-observed`} /> : <StatusBadge status={observed.tx.status === 'SUCCESS' ? 'OK' : 'FAIL'} label={observed.tx.status} />}
            </dd>
          </div>
          <div>
            <dt>Ledger number</dt>
            <dd>{observed !== undefined && observed.tx.status !== 'NOT_FOUND' ? <code>{observed.tx.ledger}</code> : '—'}</dd>
          </div>
          <div>
            <dt>Payment channel</dt>
            <dd>
              <Hash value={run.parties.channelId} href={run.links.channel} />
            </dd>
          </div>
        </dl>

        <figure className="money" aria-label="Where the money went">
          <div className="money-node money-channel">
            <span className="money-label">Payment channel deposit</span>
            <strong>{deposit === undefined ? '—' : formatAmount(deposit)}</strong>
            <span className="muted small">locked by the fleet before charging</span>
          </div>
          <svg className="money-arrows" viewBox="0 0 100 200" preserveAspectRatio="none" aria-hidden="true">
            <path d="M0 100 C 50 100, 50 40, 96 40" />
            <path d="M0 100 C 50 100, 50 160, 96 160" />
          </svg>
          <div className="money-outs">
            <div className="money-node money-station">
              <span className="money-label">To the station</span>
              <strong>{withdraw === undefined ? formatAmount(run.settlement.settled) : formatAmount(units(withdraw.amount))}</strong>
              <span className="muted small">{withdraw === undefined ? 'recorded, not re-observed' : 'withdraw event on the ledger'}</span>
              <ExternalLink href={run.links.station}>Station account</ExternalLink>
            </div>
            <div className="money-node money-fleet">
              <span className="money-label">Back to the fleet</span>
              <strong>{refund === undefined ? '—' : formatAmount(units(refund.amount))}</strong>
              <span className="muted small">{refund === undefined ? 'not observed' : 'refund event on the ledger'}</span>
              <ExternalLink href={run.links.fleet}>Fleet account</ExternalLink>
            </div>
          </div>
          <figcaption className="muted small">
            Amounts from the contract events of the close transaction. Asset: <ExternalLink href={run.links.asset}>Testnet USDC</ExternalLink>, no real value.
          </figcaption>
        </figure>

        {balances === undefined ? null : (
          <div className="table-wrap">
            <table className="balances">
              <caption>Wallet balances recorded around the close (USDC)</caption>
              <thead>
                <tr>
                  <th scope="col">Wallet</th>
                  <th scope="col">Before</th>
                  <th scope="col">After</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">Station</th>
                  <td className="num">{trimDecimal(balances.before['recipient'] ?? '0')}</td>
                  <td className="num">{trimDecimal(balances.after['recipient'] ?? '0')}</td>
                </tr>
                <tr>
                  <th scope="row">Fleet</th>
                  <td className="num">{trimDecimal(balances.before['funder'] ?? '0')}</td>
                  <td className="num">{trimDecimal(balances.after['funder'] ?? '0')}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

/** Section 6: read-only Stellar CLI commands for every on-chain fact, with what the demo observed. */
export function CheckItYourself({ run }: { run: RealRunView }) {
  const links: [string, string][] = [
    ['Close transaction', run.links.closeTx],
    ['Channel contract', run.links.channel],
    ['Station account', run.links.station],
    ['Fleet account', run.links.fleet],
    ['USDC contract', run.links.asset],
  ];
  return (
    <section id="cli" className="section" aria-labelledby="cli-title">
      <SectionHeader id="cli" eyebrow="6 · Check it yourself" title="Do not trust us: ask the ledger" layer="ON_CHAIN">
        Every on-chain fact above can be checked outside our software. These commands are read-only: they need the Stellar CLI and no keys (any
        public address works as <code>--source-account</code> for a read).
      </SectionHeader>
      <div className="terminal" role="region" aria-label="Stellar CLI commands and observed output">
        <div className="terminal-bar" aria-hidden="true">
          <span />
          <span />
          <span />
          <em>stellar CLI · testnet · read-only</em>
        </div>
        {run.cli.map((cli) => (
          <div key={cli.command} className="terminal-block">
            <p className="terminal-comment"># {cli.purpose}</p>
            <div className="terminal-command">
              <code>
                <span aria-hidden="true">$ </span>
                {cli.command}
              </code>
              <CopyButton text={cli.command} />
            </div>
            <div className="terminal-output" aria-label="Observed output">
              {cli.observed.map((line) => (
                <code key={line} className={line === '(not observed)' ? 'not-observed' : ''}>
                  {line}
                </code>
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="muted small terminal-note">
        The CLI prints amounts in USDC base units (7 decimals): <code>{run.settlement.settled}</code> = {formatAmount(run.settlement.settled)}.
      </p>
      <p className="explorer-title">
        <LayerBadge layer="ON_CHAIN" /> Open on stellar.expert, the public Testnet explorer:
      </p>
      <ul className="explorer-links" aria-label="Explorer links">
        {links.map(([label, href]) => (
          <li key={label}>
            <a className="explorer-link" href={href} target="_blank" rel="noopener noreferrer" aria-label={`${label} on stellar.expert`}>
              <span>{label}</span>
              <span aria-hidden="true">↗</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
