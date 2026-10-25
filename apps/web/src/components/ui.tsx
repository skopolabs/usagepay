import { createContext, useContext, useState, type ReactNode } from 'react';
import { short } from '@usagepay/demo/format';
import type { SectionId } from '../presenter.ts';

/** Plain first, proof second (SPEC 05 D7): technical detail is one toggle away, never shown instead of the explanation. */
export const TechnicalContext = createContext<boolean>(false);
export const useTechnical = () => useContext(TechnicalContext);

type Tone = 'ok' | 'bad' | 'wait' | 'info';

/** SPEC 05 §4.2: every status has its own icon and words; NOT_AVAILABLE and unknown statuses are never green. */
const STATUS: Record<string, { readonly tone: Tone; readonly icon: string; readonly text: string }> = {
  OK: { tone: 'ok', icon: '✔', text: 'OK' },
  PASS: { tone: 'ok', icon: '✔', text: 'PASS' },
  REJECTED: { tone: 'bad', icon: '✘', text: 'Refused' },
  FAIL: { tone: 'bad', icon: '✘', text: 'FAIL' },
  PENDING: { tone: 'wait', icon: '…', text: 'Pending' },
  NOT_AVAILABLE: { tone: 'wait', icon: '…', text: 'Not available' },
  INFO: { tone: 'info', icon: '', text: 'Info' },
};

export function statusOf(status: string) {
  return STATUS[status] ?? { tone: 'wait' as const, icon: '…', text: status };
}

export function StatusBadge({ status, label, large = false }: { status: string; label?: string; large?: boolean }) {
  const s = statusOf(status);
  return (
    <span className={`status status-${s.tone}${large ? ' status-large' : ''}`} data-status={status}>
      {s.icon === '' ? null : <span aria-hidden="true" className="status-icon">{s.icon}</span>}
      <span>{label ?? s.text}</span>
    </span>
  );
}

/** `compact` drops the second half of the label for narrow cards; the full meaning stays in the title. */
export function LayerBadge({ layer, compact = false }: { layer: string; compact?: boolean }) {
  return layer === 'ON_CHAIN' ? (
    <span className="layer layer-on" data-layer="ON_CHAIN" title="ON-CHAIN · Stellar: read from or written to the public Stellar Testnet ledger">
      <StellarMark /> {compact ? 'ON-CHAIN' : 'ON-CHAIN · Stellar'}
    </span>
  ) : (
    <span className="layer layer-off" data-layer="OFF_CHAIN" title="OFF-CHAIN · signed message: a signed message between the parties; it does not touch the ledger">
      <SignatureMark /> {compact ? 'OFF-CHAIN' : 'OFF-CHAIN · signed message'}
    </span>
  );
}

const EVIDENCE_FALLBACK: Record<string, string> = { REAL_TESTNET: 'Real Stellar Testnet', SDK_INTEGRATION: 'Real code, simulated ledger', OFFLINE_FIXTURE: 'Offline fixture' };

export function EvidenceBadge({ evidenceClass, label }: { evidenceClass: string; label?: string }) {
  return (
    <span className={`evidence evidence-${evidenceClass.toLowerCase()}`} data-evidence={evidenceClass}>
      {label ?? EVIDENCE_FALLBACK[evidenceClass] ?? evidenceClass}
      <code>{evidenceClass}</code>
    </span>
  );
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="external" href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <span aria-hidden="true"> ↗</span>
    </a>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = () => {
    const done = (next: 'copied' | 'failed') => {
      setState(next);
      setTimeout(() => setState('idle'), 1600);
    };
    if (navigator.clipboard === undefined) return done('failed');
    navigator.clipboard.writeText(text).then(() => done('copied'), () => done('failed'));
  };
  return (
    <button type="button" className="copy" onClick={copy} aria-label={`${label}: ${text}`}>
      {state === 'copied' ? 'Copied ✔' : state === 'failed' ? 'Select and copy' : label}
    </button>
  );
}

/** A hash, key or address: shortened for reading, full value one copy away (and in the title). */
export function Hash({ value, href, head = 8, tail = 6 }: { value: string; href?: string; head?: number; tail?: number }) {
  const technical = useTechnical();
  const text = technical ? value : short(value, head, tail);
  return (
    <span className="hash">
      {href === undefined ? <code title={value}>{text}</code> : <ExternalLink href={href}><code title={value}>{text}</code></ExternalLink>}
      <CopyButton text={value} />
    </span>
  );
}

export function SectionHeader({ id, eyebrow, title, layer, children }: { id: SectionId; eyebrow: string; title: string; layer?: 'OFF_CHAIN' | 'ON_CHAIN' | 'BOTH'; children?: ReactNode }) {
  return (
    <header className="section-header">
      <p className="eyebrow">
        {eyebrow}
        {layer === undefined ? null : layer === 'BOTH' ? (
          <>
            {' '}
            <LayerBadge layer="OFF_CHAIN" compact /> <LayerBadge layer="ON_CHAIN" compact />
          </>
        ) : (
          <>
            {' '}
            <LayerBadge layer={layer} />
          </>
        )}
      </p>
      <h2 id={`${id}-title`} tabIndex={-1}>
        {title}
      </h2>
      {children === undefined ? null : <div className="lead">{children}</div>}
    </header>
  );
}

export function StellarMark() {
  return (
    <svg className="mark" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2.5l2.6 6.1 6.4.5-4.9 4.2 1.5 6.4L12 16.3l-5.6 3.4 1.5-6.4L3 9.1l6.4-.5z" fill="currentColor" />
    </svg>
  );
}

export function SignatureMark() {
  return (
    <svg className="mark" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 18c3-1 4-9 6-9s0 8 2 8 2-4 4-4 2 3 4 3" />
      <path d="M3 21h18" />
    </svg>
  );
}

const ICONS: Record<string, ReactNode> = {
  meter: (
    <>
      <rect x="5" y="3" width="11" height="18" rx="2" />
      <path d="M8 7h5M10.5 10l-2 4h4l-2 4" />
      <path d="M16 9h2a1 1 0 0 1 1 1v6a2 2 0 0 0 2 2" />
    </>
  ),
  fleet: (
    <>
      <path d="M3 16v-3l2-5h14l2 5v3z" />
      <path d="M3 13h18" />
      <circle cx="7.5" cy="17" r="1.8" />
      <circle cx="16.5" cy="17" r="1.8" />
    </>
  ),
  station: (
    <>
      <path d="M4 21h16" />
      <path d="M6 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16" />
      <path d="M8 7h6" />
      <path d="M16 10h2v5a1.5 1.5 0 0 0 3 0V8l-2-2" />
    </>
  ),
  stellar: (
    <>
      <ellipse cx="12" cy="6" rx="7" ry="3" />
      <path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6" />
      <path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
    </>
  ),
  auditor: (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15l5.5 5.5" />
      <path d="M8 10.5l2 2 3.5-3.5" />
    </>
  ),
};

export function ActorIcon({ actor }: { actor: string }) {
  return (
    <svg className={`actor-icon actor-${actor}`} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {ICONS[actor] ?? <circle cx="12" cy="12" r="8" />}
    </svg>
  );
}
