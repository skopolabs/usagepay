import { useState } from 'react';
import type { DemoBundle } from '../bundle.ts';
import { EvidenceBadge, SectionHeader, StatusBadge, useTechnical } from './ui.tsx';
import { Timeline } from './Timeline.tsx';

type Scenario = DemoBundle['scenarios'][number];

const outcome = (o: Scenario['expected']) => `${o.status}${o.reasonCode === undefined ? '' : ` · ${o.reasonCode}`}`;

/** Section 8: S1 and F1-F7 with the same weight as the happy path. Refusals are shown as protection, not errors. */
export function Scenarios({ bundle, selected, onSelect }: { bundle: DemoBundle; selected: string; onSelect: (id: string) => void }) {
  const current = bundle.scenarios.find((s) => s.id === selected);
  return (
    <section id="scenarios" className="section" aria-labelledby="scenarios-title">
      <SectionHeader id="scenarios" eyebrow="8 · What if something goes wrong?" title="Attacks and failures we test, and what stops them" layer="BOTH">
        Each scenario runs the real meter, fleet and station code with real Stellar MPP SDK signatures; only the ledger is simulated, so they are
        repeatable. Pick one to replay its story.
      </SectionHeader>
      <div className="scenario-grid" role="tablist" aria-label="Scenarios">
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
            <span className="scenario-title">{s.title}</span>
            <span className="scenario-question">{s.question}</span>
            <span className="scenario-outcome">
              <span className="muted small">Outcome</span>
              <StatusBadge status={s.actual.status} />
              <StatusBadge status={s.result} label={s.result === 'PASS' ? 'As expected' : 'Not as expected'} />
            </span>
          </button>
        ))}
      </div>
      {current === undefined ? null : <ScenarioDetail bundle={bundle} scenario={current} />}
    </section>
  );
}

function ScenarioDetail({ bundle, scenario }: { bundle: DemoBundle; scenario: Scenario }) {
  const technical = useTechnical();
  const evidence = bundle.evidenceClasses?.[scenario.evidenceClass];
  return (
    <article id="scenario-panel" className="scenario-detail" role="tabpanel" aria-labelledby={`scenario-tab-${scenario.id}`}>
      <header>
        <p className="eyebrow">
          {scenario.id} · <EvidenceBadge evidenceClass={scenario.evidenceClass} {...(evidence === undefined ? {} : { label: evidence.label })} />
        </p>
        <h3>{scenario.question}</h3>
        <p className="scenario-answer">{scenario.answer}</p>
        {evidence === undefined ? null : <p className="muted small">{evidence.plain}</p>}
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

      <div className="table-wrap">
        <table className="checkpoints">
          <caption>
            Checkpoints: {scenario.checkpoints.filter((p) => p.ok).length} of {scenario.checkpoints.length} as expected
          </caption>
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

      <Timeline events={scenario.story} actors={bundle.actors} label={`Recorded events of scenario ${scenario.id}`} highlightRefusals />
    </article>
  );
}
