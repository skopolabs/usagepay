import { useEffect, useRef, useState } from 'react';
import { short } from '@usagepay/demo/format';
import { progressOf, utc, type DemoBundle, type StoryEvent } from '../bundle.ts';
import { PLAYBACK_INTERVAL_MS } from '../presenter.ts';
import { ActorIcon, ExternalLink, LayerBadge, StatusBadge, useTechnical } from './ui.tsx';

/** Lane order: the three off-chain parties and the auditor, then the public ledger in its own on-chain lane. */
const LANES = ['meter', 'fleet', 'station', 'auditor', 'stellar'] as const;

export interface TimelineProps {
  readonly events: readonly StoryEvent[];
  readonly actors: DemoBundle['actors'];
  /** Accessible name of the event list. */
  readonly label: string;
  /** Set for a captured Testnet run: the REPLAY label stays visible with its recording time (SPEC 05 D8). */
  readonly replay?: { readonly runId: string; readonly recordedAt: string };
  /** Marks refusals and unknown outcomes as the protection at work (scenario explorer). */
  readonly highlightRefusals?: boolean;
  /** Each change toggles playback (presenter `Space`). */
  readonly toggleSignal?: number;
}

/**
 * Swimlane replay of recorded story events. Playback only reveals events that were recorded, in their recorded order,
 * at the presenter's pace; it never invents or re-times anything.
 */
export function Timeline({ events, actors, label, replay, highlightRefusals = false, toggleSignal }: TimelineProps) {
  const technical = useTechnical();
  const total = events.length;
  const [shown, setShown] = useState(total);
  const [playing, setPlaying] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  const lastSignal = useRef(toggleSignal);

  useEffect(() => {
    setShown(total);
    setPlaying(false);
  }, [events, total]);

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      setShown((n) => {
        if (n >= total) {
          setPlaying(false);
          return n;
        }
        return n + 1;
      });
    }, PLAYBACK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [playing, total]);

  useEffect(() => {
    if (!playing) return;
    const last = listRef.current?.lastElementChild;
    if (last instanceof HTMLElement) last.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [shown, playing]);

  const toggle = () => {
    if (playing) return setPlaying(false);
    if (shown >= total) setShown(0);
    setPlaying(true);
  };
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;

  useEffect(() => {
    if (toggleSignal === undefined || toggleSignal === lastSignal.current) return;
    lastSignal.current = toggleSignal;
    toggleRef.current();
  }, [toggleSignal]);

  const visible = events.slice(0, shown);
  const progress = progressOf(visible);
  const hasMilestones = (() => {
    const all = progressOf(events);
    return all.readings + all.vouchers + all.transactions > 0;
  })();
  const firstAlarm = highlightRefusals ? events.findIndex((e) => e.status === 'REJECTED' || e.status === 'PENDING') : -1;

  return (
    <div className={playing ? 'timeline timeline-playing' : 'timeline'}>
      <div className="timeline-bar">
        <div className="timeline-controls" role="group" aria-label="Replay controls">
          <button type="button" onClick={toggle} aria-pressed={playing}>
            {playing ? '❚❚ Pause' : shown >= total ? '▶ Replay step by step' : '▶ Play'}
          </button>
          <button type="button" onClick={() => { setPlaying(false); setShown((n) => Math.max(0, n - 1)); }} disabled={shown === 0}>
            ◀ Step
          </button>
          <button type="button" onClick={() => { setPlaying(false); setShown((n) => Math.min(total, n + 1)); }} disabled={shown >= total}>
            Step ▶
          </button>
          <button type="button" onClick={() => { setPlaying(false); setShown(total); }} disabled={shown >= total}>
            Show all
          </button>
          <span className="timeline-count" aria-live="polite">
            Event {shown} of {total}
          </span>
        </div>
        {replay === undefined ? null : (
          <p className="replay-tag">
            <strong>REPLAY</strong> of run <code>{replay.runId}</code>, recorded {utc(replay.recordedAt)}
          </p>
        )}
      </div>

      {hasMilestones ? (
        <dl className="counters" aria-label="Progress so far">
          <div>
            <dt>Signed readings</dt>
            <dd>{progress.readings}</dd>
          </div>
          <div className="counter-off">
            <dt>Off-chain vouchers</dt>
            <dd>{progress.vouchers}</dd>
          </div>
          <div className="counter-off">
            <dt>Fleet receipts</dt>
            <dd>{progress.receipts}</dd>
          </div>
          <div className="counter-on">
            <dt>Stellar transactions</dt>
            <dd>{progress.transactions}</dd>
          </div>
          <div className={progress.sealed ? 'counter-sealed' : ''}>
            <dt>Evidence package (E0)</dt>
            <dd>{progress.sealed ? 'Sealed' : 'Open'}</dd>
          </div>
        </dl>
      ) : null}

      <div className="lanes-head" aria-hidden="true">
        {LANES.map((lane) => (
          <span key={lane} className={`lane-head lane-${lane}`} title={actors[lane].name}>
            <ActorIcon actor={lane} />
          </span>
        ))}
        <span className="lanes-legend">
          <span className="legend-off">Off-chain lanes: meter · fleet · station · auditor</span>
          <span className="legend-on">On-chain lane: Stellar</span>
        </span>
      </div>

      <ol className="events" ref={listRef} aria-label={label}>
        {visible.map((event, index) => {
          const lane = LANES.indexOf(event.actor as (typeof LANES)[number]);
          const alarm = index === firstAlarm;
          const e0 = event.technical['event'] === 'e0.written' ? event.technical['e0Digest'] : undefined;
          return (
            <li key={index} className={`event event-${event.layer === 'ON_CHAIN' ? 'on' : 'off'} event-${event.status.toLowerCase()}${alarm ? ' event-alarm' : ''}`} data-actor={event.actor} data-layer={event.layer}>
              <div className="rails" aria-hidden="true">
                {LANES.map((l, i) => (
                  <span key={l} className={`rail rail-${l}${i === lane ? ' rail-active' : ''}`}>
                    {i === lane ? <span className="dot" /> : null}
                  </span>
                ))}
              </div>
              <article className="event-card">
                <header className="event-meta">
                  <span className="event-actor">
                    <ActorIcon actor={event.actor} />
                    {actors[event.actor]?.name ?? event.actor}
                  </span>
                  <LayerBadge layer={event.layer} />
                  <StatusBadge status={event.status} />
                  {technical && event.at !== undefined ? <time dateTime={event.at}>{utc(event.at, true)}</time> : null}
                </header>
                {alarm ? <p className="alarm">{event.status === 'PENDING' ? 'Outcome unknown here: nothing is counted as paid.' : 'Refused here: this is the protection working.'}</p> : null}
                <h3 className="event-title">{event.title}</h3>
                <p className="event-detail">{event.detail}</p>
                {e0 === undefined ? null : (
                  <p className="stamp" title={e0}>
                    <span>SEALED</span> E0 · {short(e0, 10, 6)}
                  </p>
                )}
                {event.links === undefined ? null : (
                  <p className="event-links">
                    {event.links.map((link) => (
                      <ExternalLink key={link.url} href={link.url}>
                        {link.label}
                      </ExternalLink>
                    ))}
                  </p>
                )}
                {technical ? (
                  <dl className="technical">
                    {Object.entries(event.technical).map(([key, value]) => (
                      <div key={key}>
                        <dt>{key}</dt>
                        <dd>
                          <code>{value}</code>
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </article>
            </li>
          );
        })}
      </ol>
      {shown === 0 ? <p className="timeline-empty">Press Play or Step to replay the recorded events.</p> : null}
    </div>
  );
}
