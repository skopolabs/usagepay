import { useCallback, useEffect, useMemo, useState } from 'react';
import { parseBundle, utc, type DemoBundle } from './bundle.ts';
import { PRESENTER_STEPS, SECTIONS, type SectionId } from './presenter.ts';
import { Actors, Gap, Overview } from './components/Overview.tsx';
import { CheckItYourself, Payment } from './components/Payment.tsx';
import { Scenarios } from './components/Scenarios.tsx';
import { Flow, Session } from './components/Session.tsx';
import { StatusBadge, TechnicalContext } from './components/ui.tsx';
import { Verify } from './components/Verify.tsx';

export function App({ raw }: { raw: unknown }) {
  const loaded = useMemo(() => parseBundle(raw), [raw]);
  if (!loaded.ok) {
    return (
      <main className="fatal" role="alert">
        <h1>The demo data could not be shown</h1>
        <p>{loaded.error}</p>
        <p>
          Regenerate it with <code>corepack pnpm demo</code> and rebuild with <code>corepack pnpm ui:build</code>.
        </p>
      </main>
    );
  }
  return <DemoPage bundle={loaded.bundle} />;
}

const ignoreKeys = (event: KeyboardEvent) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return true;
  const target = event.target as HTMLElement | null;
  return target !== null && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
};

/** Space toggles the replay unless a control has focus, where it keeps its native meaning (press a button). */
const isControl = (target: EventTarget | null) => target instanceof HTMLElement && ['BUTTON', 'A', 'SUMMARY'].includes(target.tagName);

function goTo(section: SectionId) {
  document.getElementById(section)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  document.getElementById(`${section}-title`)?.focus({ preventScroll: true });
}

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

function DemoPage({ bundle }: { bundle: DemoBundle }) {
  const run = bundle.realRun.status === 'MISSING' ? undefined : bundle.realRun;
  const [technical, setTechnical] = useState(false);
  const [step, setStep] = useState<number | undefined>(undefined);
  const [startedAt, setStartedAt] = useState<number | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  const [toggleSignal, setToggleSignal] = useState(0);
  const [scenario, setScenario] = useState(bundle.scenarios.find((s) => s.id === 'F1')?.id ?? bundle.scenarios[0]?.id ?? '');

  // Sections absent from this bundle (no captured run) are skipped by the presenter.
  const present = useMemo(() => new Set<SectionId>(run === undefined ? ['overview', 'gap', 'actors', 'scenarios'] : SECTIONS.map((s) => s.id)), [run]);
  const steps = useMemo(() => PRESENTER_STEPS.filter((s) => present.has(s.section)), [present]);

  const moveTo = useCallback(
    (index: number) => {
      const bounded = Math.max(0, Math.min(steps.length - 1, index));
      const target = steps[bounded];
      if (target === undefined) return;
      setStep(bounded);
      setStartedAt((t) => t ?? Date.now());
      goTo(target.section);
    },
    [steps],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (ignoreKeys(event)) return;
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        moveTo(step === undefined ? 0 : step + 1);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        moveTo(step === undefined ? 0 : step - 1);
      } else if (event.key === ' ' && !isControl(event.target)) {
        event.preventDefault();
        setToggleSignal((n) => n + 1);
      } else if (event.key === 't' || event.key === 'T') {
        setTechnical((v) => !v);
      } else if (event.key === 's' || event.key === 'S') {
        const index = steps.findIndex((s) => s.section === 'scenarios');
        if (index >= 0) moveTo(index);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [moveTo, step, steps]);

  // A shared link such as `#verify` opens on that section once the page has rendered.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (id !== '') document.getElementById(id)?.scrollIntoView?.({ block: 'start', behavior: 'instant' });
  }, []);

  useEffect(() => {
    if (startedAt === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  const current = step === undefined ? undefined : steps[step];
  const currentLabel = SECTIONS.find((s) => s.id === current?.section)?.label;
  const elapsed = startedAt === undefined ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000));

  return (
    <TechnicalContext.Provider value={technical}>
      <a className="skip" href="#overview">
        Skip to content
      </a>
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="#overview">
            UsagePay<sup className="brand-sup">on Stellar</sup>
          </a>
          <span className="badge-testnet">TESTNET ONLY</span>
          {run === undefined ? null : (
            <span className="badge-replay" title={`Recorded ${run.recordedAt}`}>
              REPLAY · {utc(run.recordedAt)}
            </span>
          )}
          <nav aria-label="Sections">
            <ul>
              {SECTIONS.filter((s) => present.has(s.id) && s.id !== 'overview').map((s) => (
                <li key={s.id}>
                  <a href={`#${s.id}`} aria-current={current?.section === s.id ? 'step' : undefined}>
                    {s.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <div className="topbar-tools">
            <StatusBadge status={bundle.result.status} label={`Demo ${bundle.result.status}`} />
            <button type="button" className="toggle" aria-pressed={technical} onClick={() => setTechnical((v) => !v)} title="Keyboard: T">
              {technical ? 'Technical: on' : 'Technical: off'}
            </button>
          </div>
        </div>
        {current === undefined ? null : (
          <p className="presenter" aria-live="polite" data-testid="presenter">
            Step {(step ?? 0) + 1} / {steps.length} · {currentLabel} · {clock(elapsed)}
            {current.targetSeconds === undefined ? '' : ` (target ${clock(current.targetSeconds)})`}
          </p>
        )}
      </header>

      <main>
        <Overview bundle={bundle} />
        <Gap />
        <Actors bundle={bundle} />
        {run === undefined ? null : (
          <>
            <Session run={run} />
            <Flow bundle={bundle} run={run} toggleSignal={toggleSignal} />
            <Payment run={run} />
            <CheckItYourself run={run} />
            <Verify run={run} />
          </>
        )}
        <Scenarios bundle={bundle} selected={scenario} onSelect={setScenario} />
      </main>

      <footer className="footer">
        <div className="footer-inner">
          <p>
            Testnet only, test USDC with no value · simulated meter · data <code>{bundle.schema}</code> generated{' '}
            {utc(bundle.generatedAt)}
          </p>
          <p className="keys">
            Presenter keys: <kbd>→</kbd> / <kbd>←</kbd> sections · <kbd>Space</kbd> play or pause the replay · <kbd>T</kbd> technical detail · <kbd>S</kbd> scenarios
          </p>
        </div>
      </footer>
    </TechnicalContext.Provider>
  );
}
