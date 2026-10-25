/**
 * Page sections in product-flow order (SPEC 05 §3) and the presenter sequence (§5). The pitch keeps evolving, so the
 * order, labels and optional time targets live here only: change this list, not the components.
 */
export type SectionId = 'overview' | 'gap' | 'actors' | 'session' | 'flow' | 'payment' | 'cli' | 'verify' | 'scenarios' | 'limits';

export interface Section {
  readonly id: SectionId;
  /** Short label for the navigation bar and the presenter indicator. */
  readonly label: string;
}

export const SECTIONS: readonly Section[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'gap', label: 'Gap' },
  { id: 'actors', label: 'Actors' },
  { id: 'session', label: 'Usage' },
  { id: 'flow', label: 'Vouchers' },
  { id: 'payment', label: 'Payment' },
  { id: 'cli', label: 'CLI' },
  { id: 'verify', label: 'Auditor' },
  { id: 'scenarios', label: 'What if' },
  { id: 'limits', label: 'Limits' },
];

export interface PresenterStep {
  readonly section: SectionId;
  /** Optional time budget for this step, shown next to the elapsed time. */
  readonly targetSeconds?: number;
}

export const PRESENTER_STEPS: readonly PresenterStep[] = SECTIONS.map((section) => ({ section: section.id }));

/** Pace of the swimlane replay: one step per tick, where a repeated round is a single step (`replaySteps`). */
export const PLAYBACK_INTERVAL_MS = 1800;
