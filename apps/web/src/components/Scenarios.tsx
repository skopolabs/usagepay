import { useState } from 'react';
import type { DemoBundle } from '../bundle.ts';
import { EvidenceBadge, SectionHeader, StatusBadge, useTechnical } from './ui.tsx';
import { Timeline } from './Timeline.tsx';

type Scenario = DemoBundle['scenarios'][number];

const outcome = (o: Scenario['expected']) => `${o.status}${o.reasonCode === undefined ? '' : ` · ${o.reasonCode}`}`;

/**
 * Section 7: S1 and F1-F7 with the same weight as the happy path. Refusals are shown as protection, not errors.
 * The S1-F7 cards are one click away ("Show details"), each in short (id, title, outcome). The open scenario's question,
 * answer and checkpoints always sit beside its story; the evidence class explanation is in the technical mode (its label
 * stays visible).
 */
export function Scenarios({ bundle, selected, onSelect }: { bundle: DemoBundle; selected: string; onSelect: (id: string) => void }) {
  const technical = useTechnical();
  const [open, setOpen] = useState(false);
  /** A scenario that did not behave as expected is never folded away. */
  const surprise = bundle.scenarios.some((s) => s.result !== 'PASS');
  const cards = open || technical || surprise;
  const current = bundle.scenarios.find((s) => s.id === selected);
  return (
    <section id="scenarios" className="section" aria-labelledby="scenarios-title">
      <SectionHeader id="scenarios" eyebrow="7 · What if something goes wrong?" title="Attacks and failures we test, and what stops them" layer="BOTH">
        Each scenario runs the real meter, fleet and station code with real Stellar MPP SDK signatures; only the ledger is simulated, so they are
        repeatable. Pick one to replay its story.
      </SectionHeader>
      {technical || surprise ? null : (
        <button type="button" className="more" aria-expanded={open} aria-controls="scenario-tabs" onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide details' : 'Show details'}
        </button>
      )}
      <div className="scenarios">
        <div className="scenario-list" hidden={!cards}>
          <div id="scenario-tabs" className="scenario-grid scenario-grid-brief" role="tablist" aria-label="Scenarios">
            {bundle.scenarios.map((s) => (
              <button
                key={s.id}
                type="button"
                role="tab"
                id={`scenario-tab-${s.id}`}
                aria-selected={s.id === selected}
                aria-controls="scenario-panel"
                className={`scenario-card${s.id === selected ? ' selected' : ''}${s.id === 'S1' ? ' scenario-happy' : ''}`}
                onClick={() => onSelect(s.id)}
              >
                <span className="scenario-id">{s.id}</span>
                <span className="scenario-title" title={s.title}>
                  {s.title}
                </span>
                <span className="scenario-outcome">
                  <StatusBadge status={s.actual.status} />
                  <StatusBadge status={s.result} label={s.result === 'PASS' ? 'As expected' : 'Not as expected'} />
                </span>
              </button>
            ))}
          </div>
        </div>
        {current === undefined ? null : <ScenarioDetail bundle={bundle} scenario={current} />}
      </div>
    </section>
  );
}

function ScenarioDetail({ bundle, scenario }: { bundle: DemoBundle; scenario: Scenario }) {
  const technical = useTechnical();
  const evidence = bundle.evidenceClasses?.[scenario.evidenceClass];
  /** A checkpoint that did not match is never folded away. */
  const matched = scenario.checkpoints.every((p) => p.ok);
  return (
    <article id="scenario-panel" className="scenario-detail" role="tabpanel" aria-labelledby={`scenario-tab-${scenario.id}`}>
      <div className="scenario-summary">
        <header>
          <p className="eyebrow">
            {scenario.id} · <EvidenceBadge evidenceClass={scenario.evidenceClass} {...(evidence === undefined ? {} : { label: evidence.label })} />
          </p>
          <h3>{scenario.question}</h3>
          <p className="scenario-answer">{scenario.answer}</p>
          {evidence === undefined || !technical ? null : <p className="muted small">{evidence.plain}</p>}
        </header>

        <dl className="expect">
          <div>
            <dt>Expected</dt>
            <dd>
              <StatusBadge status={scenario.expected.status} /> <code>{outcome(scenario.expected)}</code>
            </dd>
          </div>
          <div>
            <dt>Actual</dt>
            <dd>
              <StatusBadge status={scenario.actual.status} /> <code>{outcome(scenario.actual)}</code>
            </dd>
          </div>
          <div>
            <dt>Result</dt>
            <dd>
              <StatusBadge status={scenario.result} label={scenario.result === 'PASS' ? 'Behaved as expected' : 'Did not behave as expected'} />
            </dd>
          </div>
        </dl>

        <details className="checkpoints-details" open={technical || !matched}>
          <summary>
            <StatusBadge status={matched ? 'PASS' : 'FAIL'} label={`Checkpoints: ${scenario.checkpoints.filter((p) => p.ok).length} of ${scenario.checkpoints.length} as expected`} />
            <span className="checkpoints-more">
              <span className="when-closed">Show details</span>
              <span className="when-open">Hide details</span>
            </span>
          </summary>
          <div className="table-wrap">
            <table className="checkpoints" aria-label={`Checkpoints of scenario ${scenario.id}`}>
              <thead>
                <tr>
                  <th scope="col">What was checked</th>
                  <th scope="col">Expected</th>
                  <th scope="col">Actual</th>
                  <th scope="col">Match</th>
                </tr>
              </thead>
              <tbody>
                {scenario.checkpoints.map((p) => (
                  <tr key={p.label}>
                    <th scope="row">{p.label}</th>
                    <td>
                      <code>{p.expected}</code>
                    </td>
                    <td>
                      <code>{p.actual}</code>
                    </td>
                    <td>
                      <StatusBadge status={p.ok ? 'PASS' : 'FAIL'} label={p.ok ? 'Yes' : 'No'} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>

        {scenario.verification === undefined ? null : (
          <div className="mini-checks" aria-label="Auditor checks in this scenario">
            <span className="muted small">Auditor:</span>
            {Object.entries(scenario.verification.checks).map(([id, check]) => (
              <span key={id} className="mini-check" title={`${id}: ${check.status}${check.reasonCode === undefined ? '' : ` ${check.reasonCode}`}`}>
                <StatusBadge status={check.status} label={technical ? `${id} ${check.status}` : id.slice(0, 3)} />
              </span>
            ))}
            <StatusBadge status={scenario.verification.overall.status} label={`Overall ${scenario.verification.overall.status}`} />
          </div>
        )}
      </div>

      <Timeline events={scenario.story} actors={bundle.actors} label={`Recorded events of scenario ${scenario.id}`} highlightRefusals />
    </article>
  );
}
