import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { App } from '../src/App.tsx';
import { KICKER, POSITIONING } from '../src/components/Overview.tsx';
import { replaySteps, utc, type DemoBundle } from '../src/bundle.ts';
import { SECTIONS } from '../src/presenter.ts';

const { live, offline, unavailable, fail, missing } = inject('bundles');

const realRun = (bundle: DemoBundle) => {
  if (bundle.realRun.status === 'MISSING') throw new Error('bundle has no real run');
  return bundle.realRun;
};

/** Any network primitive the page could use; UI-AC09 requires that none is ever called. */
const network = { fetch: vi.fn(), xhr: vi.fn(), socket: vi.fn(), source: vi.fn(), beacon: vi.fn() };

beforeEach(() => {
  vi.stubGlobal('fetch', network.fetch);
  vi.stubGlobal('WebSocket', network.socket);
  vi.stubGlobal('EventSource', network.source);
  vi.spyOn(XMLHttpRequest.prototype, 'open').mockImplementation(network.xhr);
  Object.defineProperty(navigator, 'sendBeacon', { value: network.beacon, configurable: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const spy of Object.values(network)) spy.mockClear();
});

/** Visible text with whitespace collapsed, as a reader sees it. */
const text = (el: Node | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ');
const hasClass = (el: Element | null | undefined, name: string) => el?.classList.contains(name) ?? false;

const show = (bundle: unknown) => render(<App raw={bundle} />);
/** The S1-F7 cards start folded; "Show details" reveals them. */
const openScenarios = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(section('scenarios').querySelector<HTMLButtonElement>('button[aria-controls="scenario-tabs"]')!);

const section = (id: string) => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`no section #${id}`);
  return el;
};

describe('UI-AC01: every story event shows actor, layer, status, title and detail', () => {
  it('renders the whole recorded Testnet run in order on the swimlane', () => {
    show(live);
    const run = realRun(live);
    const items = within(screen.getByRole('list', { name: 'Recorded events of the Testnet run' })).getAllByRole('listitem');
    expect(items).toHaveLength(run.story.length);
    run.story.forEach((event, index) => {
      const item = items[index]!;
      expect(item.dataset['actor']).toBe(event.actor);
      expect(text(item)).toContain(live.actors[event.actor].name);
      expect(item.querySelector(`[data-layer="${event.layer}"]`)).not.toBeNull();
      const status = item.querySelector(`[data-status="${event.status}"]`);
      expect(status?.textContent?.trim()).not.toBe('');
      expect(within(item).getByRole('heading', { name: event.title })).toBeTruthy();
      expect(text(item)).toContain(event.detail);
    });
  });

  it('marks on-chain and off-chain steps differently and counts 3 vouchers before 1 transaction', async () => {
    const user = userEvent.setup();
    show(live);
    const flow = section('flow');
    const counters = within(flow).getByLabelText('Progress so far');
    expect(text(within(counters).getByText('Off-chain vouchers').nextSibling)).toContain('3');
    expect(text(within(counters).getByText('Stellar transactions').nextSibling)).toContain('1');
    // Step back to the moment before the close was sent: three vouchers, no transaction yet.
    const run = realRun(live);
    const submitted = run.story.findIndex((e) => e.technical['event'] === 'settlement.close.submitted');
    for (let i = run.story.length; i > submitted; i--) await user.click(within(flow).getByRole('button', { name: '◀ Step' }));
    expect(text(within(counters).getByText('Off-chain vouchers').nextSibling)).toContain('3');
    expect(text(within(counters).getByText('Stellar transactions').nextSibling)).toContain('0');
    expect(within(flow).getByText(/SEALED/)).toBeTruthy();
  });

  it('reveals the public technical fields only on demand', async () => {
    const user = userEvent.setup();
    show(live);
    const digest = realRun(live).e0Digest;
    expect(section('flow').textContent).not.toContain(digest);
    await user.keyboard('t');
    expect(section('flow').textContent).toContain(digest);
  });

  it('"Highlight a layer" fades the other layer and keeps every event and check', async () => {
    const user = userEvent.setup();
    show(live);
    const group = screen.getByRole('group', { name: 'Highlight a layer' });
    expect(within(group).getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true');
    const events = within(section('flow')).getAllByRole('listitem').length;
    await user.click(within(group).getByRole('button', { name: 'On-chain' }));
    expect(within(group).getByRole('button', { name: 'On-chain' }).getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('main')?.dataset['show']).toBe('ON_CHAIN');
    expect(within(section('flow')).getAllByRole('listitem')).toHaveLength(events);
    expect(document.querySelector('[data-check="V08_CHAIN"]')?.getAttribute('data-layer')).toBe('ON_CHAIN');
  });
});

describe('Replay pacing: a round that repeats the previous one plays as one step, in short', () => {
  it('covers every recorded event once, in order, and never folds a refusal or an unknown outcome', () => {
    for (const story of [realRun(live).story, ...live.scenarios.map((s) => s.story)]) {
      const steps = replaySteps(story);
      expect(steps.flatMap((step) => story.slice(step.start, step.end))).toEqual(story);
      for (const step of steps) expect(step.end > step.start).toBe(true);
      for (const step of steps.filter((s) => s.end - s.start > 1)) {
        expect(story.slice(step.start, step.end).every((e) => e.status === 'OK' || e.status === 'INFO')).toBe(true);
      }
    }
    // The real run: three readings, then one voucher round per reading; rounds 2 and 3 are one step each.
    const repeats = replaySteps(realRun(live).story).filter((s) => s.round !== undefined && s.round.first > 1);
    expect(repeats.map((s) => [s.round?.first, s.round?.of, s.end - s.start])).toEqual([[2, 3, 2], [2, 3, 7], [3, 3, 7]]);
  });

  it('steps through the first round event by event and reveals a repeated round at once, details on demand', async () => {
    const user = userEvent.setup();
    show(live);
    const flow = section('flow');
    const list = within(flow).getByRole('list', { name: 'Recorded events of the Testnet run' });
    const steps = replaySteps(realRun(live).story);
    const round2 = steps.findIndex((s) => s.round !== undefined && s.round.first === 2 && s.round.length > 1);
    await user.click(within(flow).getByRole('button', { name: '▶ Replay step by step' }));
    await user.click(within(flow).getByRole('button', { name: '❚❚ Pause' }));
    expect(within(list).queryAllByRole('listitem')).toHaveLength(0);
    for (let i = 0; i < round2; i++) await user.click(within(flow).getByRole('button', { name: 'Step ▶' }));
    expect(within(list).queryAllByRole('listitem')).toHaveLength(steps[round2]!.start);
    await user.click(within(flow).getByRole('button', { name: 'Step ▶' }));
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(steps[round2]!.end);
    const repeated = items.slice(steps[round2]!.start);
    expect(text(repeated[0])).toContain('Round 2 of 3 · same 7 steps as round 1, shown in short');
    for (const item of repeated) expect(item.querySelector('.event-detail')?.hasAttribute('hidden')).toBe(true);
    await user.click(within(repeated[0]!).getByRole('button', { name: 'Show details' }));
    for (const item of repeated) expect(item.querySelector('.event-detail')?.hasAttribute('hidden')).toBe(false);
  });
});

describe('UI-AC02: every on-chain fact has an explorer link or a CLI equivalent with its observed output', () => {
  it('shows each stellar CLI command with the observed output and a copy button', () => {
    show(live);
    const terminal = screen.getByRole('region', { name: 'Stellar CLI commands and observed output' });
    for (const cli of realRun(live).cli) {
      expect(text(terminal)).toContain(cli.command);
      for (const line of cli.observed) expect(text(terminal)).toContain(line.replace(/\s+/g, ' '));
      expect(within(terminal).getByRole('button', { name: `Copy: ${cli.command}` })).toBeTruthy();
    }
  });

  it('links the close transaction, channel and accounts to stellar.expert and keeps on-chain story links', () => {
    show(live);
    const run = realRun(live);
    const hrefs = [...document.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    for (const link of Object.values(run.links)) expect(hrefs).toContain(link);
    for (const event of run.story.filter((e) => e.layer === 'ON_CHAIN' && e.links !== undefined)) {
      for (const link of event.links!) expect(hrefs).toContain(link.url);
    }
    expect(text(section('payment'))).toContain(String(run.ledger.status === 'OBSERVED' && run.ledger.tx.status !== 'NOT_FOUND' ? run.ledger.tx.ledger : ''));
  });

  it('copies a command to the clipboard', async () => {
    const user = userEvent.setup();
    show(live);
    const command = realRun(live).cli[0]!.command;
    await user.click(screen.getByRole('button', { name: `Copy: ${command}` }));
    expect(await navigator.clipboard.readText()).toBe(command);
  });
});

describe('UI-AC03: REPLAY and the recording time are visible with the replayed run', () => {
  it.each([['live', live], ['offline', offline], ['unavailable', unavailable], ['fail', fail]] as const)('%s bundle', (_name, bundle) => {
    show(bundle);
    const run = realRun(bundle);
    const recorded = utc(run.recordedAt);
    expect(text(section('flow'))).toContain(`REPLAY of run ${run.runId}, recorded ${recorded}`);
  });
});

describe('UI-AC04: V01-V08 with question and status; NOT_AVAILABLE and FAIL never look like success', () => {
  it('lists all eight checks with their plain question, the first two until "Show the other 6 checks"', async () => {
    const user = userEvent.setup();
    show(live);
    const list = screen.getByRole('list', { name: 'Verification checks' });
    expect(within(list).getAllByRole('listitem').map((c) => c.dataset['check'])).toEqual(['V01_SCHEMA', 'V02_METER']);
    await user.click(within(section('verify')).getByRole('button', { name: 'Show the other 6 checks' }));
    const checks = within(list).getAllByRole('listitem');
    expect(checks.map((c) => c.dataset['check'])).toEqual(['V01_SCHEMA', 'V02_METER', 'V03_TARIFF', 'V04_EVIDENCE', 'V05_MPP', 'V06_PAYER_ACK', 'V07_E0_E1_LINK', 'V08_CHAIN']);
    for (const check of realRun(live).verification.checks) {
      const item = checks.find((c) => c.dataset['check'] === check.id)!;
      expect(text(item)).toContain(check.question);
      expect(hasClass(item.querySelector('[data-status="PASS"]'), 'status-ok')).toBe(true);
    }
    expect(text(screen.getByRole('status', { name: 'Auditor verdict' }))).toContain('AUDITOR VERDICT: PASS');
  });

  it.each([
    ['offline', offline, 'NOT_AVAILABLE', 'status-wait'],
    ['unavailable', unavailable, 'NOT_AVAILABLE', 'status-wait'],
    ['fail', fail, 'FAIL', 'status-bad'],
  ] as const)('%s bundle shows V08 %s with its own colour and words', (_name, bundle, status, tone) => {
    show(bundle);
    const v08 = document.querySelector('[data-check="V08_CHAIN"]')!;
    expect(v08.hasAttribute('hidden')).toBe(false);
    const badge = v08.querySelector(`[data-status="${status}"]`);
    expect(hasClass(badge, tone)).toBe(true);
    expect(text(badge)).not.toContain('PASS');
    expect(text(screen.getByRole('status', { name: 'Auditor verdict' }))).toContain(`AUDITOR VERDICT: ${status}`);
    expect(section('overview').querySelector(`.demo-result [data-status="${bundle.result.status}"]`)).not.toBeNull();
  });

  it.each([['live', live], ['offline', offline], ['unavailable', unavailable], ['fail', fail], ['missing', missing]] as const)(
    '%s bundle: no failing or unavailable status anywhere is rendered green',
    (_name, bundle) => {
      show(bundle);
      for (const badge of document.querySelectorAll('[data-status]')) {
        const status = badge.getAttribute('data-status');
        if (status !== 'PASS' && status !== 'OK') expect(hasClass(badge, 'status-ok')).toBe(false);
      }
    },
  );
});

describe('UI-AC05: S1 and F1-F7 are reachable with expected vs actual, evidence class and checkpoints', () => {
  it('opens every scenario', async () => {
    const user = userEvent.setup();
    show(live);
    await openScenarios(user);
    const tabs = within(screen.getByRole('tablist', { name: 'Scenarios' })).getAllByRole('tab');
    expect(tabs).toHaveLength(8);
    for (const scenario of live.scenarios) {
      await user.click(screen.getByRole('tab', { name: new RegExp(`^${scenario.id}`) }));
      const panel = screen.getByRole('tabpanel');
      expect(text(panel)).toContain(scenario.question);
      expect(text(panel)).toContain(scenario.answer);
      expect(panel.querySelector(`[data-evidence="${scenario.evidenceClass}"]`)).not.toBeNull();
      const expected = within(panel).getByText('Expected', { selector: 'dt' }).parentElement!;
      expect(text(expected)).toContain(scenario.expected.status);
      const actual = within(panel).getByText('Actual', { selector: 'dt' }).parentElement!;
      expect(text(actual)).toContain(scenario.actual.status);
      for (const point of scenario.checkpoints) expect(text(panel)).toContain(point.label);
      const story = within(panel).getByRole('list', { name: `Recorded events of scenario ${scenario.id}` });
      expect(within(story).queryAllByRole('listitem')).toHaveLength(scenario.story.length);
    }
  });

  it('the S1-F7 cards fold until "Show details", the open scenario stays shown; checkpoints fold behind their count', async () => {
    const user = userEvent.setup();
    show(live);
    const s1 = live.scenarios[0]!;
    expect(screen.queryByRole('tablist', { name: 'Scenarios' })).toBeNull();
    expect(text(screen.getByRole('tabpanel'))).toContain(live.scenarios.find((s) => s.id === 'F1')!.question);
    const toggle = section('scenarios').querySelector<HTMLButtonElement>('button[aria-controls="scenario-tabs"]')!;
    expect(text(toggle)).toBe('Show details');
    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const card = screen.getByRole('tab', { name: new RegExp(`^${s1.id}`) });

    await user.click(card);
    const folded = screen.getByRole('tabpanel').querySelector('details.checkpoints-details')!;
    expect(folded.hasAttribute('open')).toBe(false);
    expect(text(folded.querySelector('summary'))).toContain(`Checkpoints: ${s1.checkpoints.length} of ${s1.checkpoints.length} as expected`);
  });

  it('F1 shows the edited reading and highlights the refusal as protection', async () => {
    const user = userEvent.setup();
    show(live);
    await openScenarios(user);
    await user.click(screen.getByRole('tab', { name: /^F1/ }));
    const panel = screen.getByRole('tabpanel');
    expect(text(panel)).toContain('10500');
    expect(text(panel)).toContain('19500');
    expect(within(panel).getByText('Refused here: this is the protection working.')).toBeTruthy();
  });
});

describe('UI-AC06: MISSING, UNAVAILABLE and NOT_AVAILABLE bundles render explicit states', () => {
  it('MISSING: says there is no real run, still shows the scenarios', async () => {
    const user = userEvent.setup();
    show(missing);
    await openScenarios(user);
    expect(text(section('overview'))).toContain('No real Testnet run');
    expect(text(section('overview'))).toContain('no g2-* run directory with e1.json');
    expect(document.getElementById('payment')).toBeNull();
    expect(text(document.querySelector('.topbar'))).not.toContain('REPLAY');
    expect(screen.getAllByRole('tab')).toHaveLength(8);
  });

  it('UNAVAILABLE ledger: the payment is shown as recorded only, not confirmed', () => {
    show(unavailable);
    const payment = section('payment');
    expect(text(payment)).toContain('Ledger not confirmed');
    expect(text(payment)).toContain('The ledger could not be read');
    expect(text(payment)).toContain('not re-observed');
    expect(text(section('cli'))).toContain('(not observed)');
  });

  it('OFFLINE: the verdict is NOT_AVAILABLE and says the ledger was not queried', () => {
    show(offline);
    expect(text(section('verify'))).toContain('OFFLINE: the ledger was not queried');
    expect(section('overview').querySelector('[data-status="NOT_AVAILABLE"]')).not.toBeNull();
  });

  it.each([
    ['null', null, 'not a JSON object'],
    ['wrong schema', { ...live, schema: 'upay.demo-bundle.v0' }, 'Unsupported demo bundle schema'],
    ['missing field', { ...live, realRun: undefined }, 'no "realRun" field'],
  ])('%s: explains the problem instead of crashing', (_name, raw, message) => {
    show(raw);
    expect(text(screen.getByRole('alert'))).toContain(message);
  });
});

describe('UI-AC07: the demo scope is stated in the footer of every view', () => {
  it.each([['live', live], ['missing', missing]] as const)('%s bundle', (_name, bundle) => {
    show(bundle);
    expect(text(document.querySelector('footer'))).toContain('Testnet only, test USDC with no value · simulated meter');
  });
});

describe('Footer (SPEC 05 §10.2): the source, pitch deck and demo video open in a new tab', () => {
  it.each([['live', live], ['missing', missing]] as const)('%s bundle', (_name, bundle) => {
    show(bundle);
    const footer = within(document.querySelector('footer') as HTMLElement);
    for (const [name, host] of [
      [/Source on GitHub/, 'https://github.com/skopolabs/usagepay'],
      [/Pitch Deck/, 'https://docs.google.com/presentation/d/'],
      [/Demo Video/, 'https://www.youtube.com/channel/'],
    ] as const) {
      const link = footer.getByRole('link', { name });
      expect(link.getAttribute('href')?.startsWith(host)).toBe(true);
      expect(link.getAttribute('target')).toBe('_blank');
    }
  });
});

describe('UI-AC08: presenter mode reaches every section by keyboard alone', () => {
  it('→ walks every section in order, ← goes back, T, S and Space work', async () => {
    const user = userEvent.setup();
    show(live);
    for (const [index, s] of SECTIONS.entries()) {
      await user.keyboard('{ArrowRight}');
      expect(document.activeElement?.id).toBe(`${s.id}-title`);
      expect(text(screen.getByTestId('presenter'))).toContain(`Step ${index + 1} / ${SECTIONS.length} · ${s.label}`);
    }
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement?.id).toBe(`${SECTIONS.at(-2)!.id}-title`);

    await user.keyboard('t');
    expect(screen.getByRole('button', { name: /Technical detail/ }).getAttribute('aria-pressed')).toBe('true');
    await user.keyboard('T');
    expect(screen.queryByRole('button', { name: /Technical detail/ })).toBeNull();

    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    await user.keyboard('s');
    expect(document.activeElement?.id).toBe('scenarios-title');

    await user.keyboard(' ');
    expect((within(section('flow')).getByRole('button', { name: /Pause/ })).getAttribute('aria-pressed')).toBe('true');
    await user.keyboard(' ');
    expect((within(section('flow')).getByRole('button', { name: /Play/ })).getAttribute('aria-pressed')).toBe('false');
  });

  it('the menu marks the section on screen while scrolling', async () => {
    show(live);
    const tops: Record<string, number> = { overview: -2000, gap: -1500, actors: -1000, session: -500, flow: 0, payment: 600, verify: 1200, scenarios: 1800, cli: 2400 };
    for (const [id, top] of Object.entries(tops)) vi.spyOn(section(id), 'getBoundingClientRect').mockReturnValue({ top } as DOMRect);
    window.dispatchEvent(new Event('scroll'));
    const nav = screen.getByRole('navigation', { name: 'Sections' });
    await waitFor(() => expect(within(nav).getByRole('link', { name: 'Vouchers' }).getAttribute('aria-current')).toBe('location'));
    expect(nav.querySelectorAll('[aria-current]')).toHaveLength(1);
  });

  it('skips the sections a bundle without a real run does not have', async () => {
    const user = userEvent.setup();
    show(missing);
    const ids: string[] = [];
    for (let i = 0; i < SECTIONS.length; i++) {
      await user.keyboard('{ArrowRight}');
      ids.push(document.activeElement?.id ?? '');
    }
    expect([...new Set(ids)]).toEqual(['overview-title', 'gap-title', 'actors-title', 'scenarios-title']);
  });
});

describe('UI-AC09: no network request other than links the user opens', () => {
  it('rendering and using every control calls no network API, and every link is user-opened', async () => {
    const user = userEvent.setup();
    show(live);
    for (const button of screen.getAllByRole('button')) await user.click(button);
    await user.keyboard('{ArrowRight}{ArrowRight} t s');
    for (const spy of Object.values(network)) expect(spy).not.toHaveBeenCalled();
    for (const a of document.querySelectorAll('a')) {
      const href = a.getAttribute('href') ?? '';
      if (href.startsWith('#')) continue;
      // Explorer pages for on-chain facts; in the footer, the project's GitHub repository, pitch deck and video channel.
      expect(href).toMatch(
        /^https:\/\/(stellar\.expert\/explorer\/testnet\/|github\.com\/skopolabs\/usagepay$|docs\.google\.com\/presentation\/d\/157kTzIG6SZ9LdqSRKgJaeVdF4ENpdYWz\/|www\.youtube\.com\/channel\/UCVkziV3cu8SnGI5tDzu37oQ$)/,
      );
      expect((a).getAttribute('target')).toBe('_blank');
      expect((a).getAttribute('rel')).toBe('noopener noreferrer');
    }
  });
});

describe('Positioning (SPEC 05 §10.4, 01.2 §0.1): the category comes first, EV charging is the demo use case', () => {
  it.each([['live', live], ['missing', missing]] as const)('%s bundle', (_name, bundle) => {
    show(bundle);
    const overview = section('overview');
    expect(text(screen.getByRole('heading', { level: 1 }))).toBe(POSITIONING);
    expect(POSITIONING).toBe('UsagePay enables verifiable machine-to-machine payments for metered services on Stellar.');
    // The kicker sits above the H1; the first screen says what the service is, and the EV use case is labelled as the
    // demo with the actors it names.
    const kicker = overview.querySelector('.kicker');
    expect(text(kicker)).toBe(KICKER);
    expect(KICKER).toBe('Infrastructure for the machine economy.');
    expect(kicker!.compareDocumentPosition(screen.getByRole('heading', { level: 1 })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const useCase = within(section('actors')).getByRole('complementary', { name: 'Demo use case' });
    expect(text(useCase)).toContain('Demo use case · EV charging');
    expect(text(overview)).not.toContain('Demo use case');
    expect(text(overview.querySelector('h1'))).not.toMatch(/kWh|kilowatt|charg/i);
    // Why MPP alone is not enough is always on the page.
    expect(text(section('gap'))).toContain('Why Stellar MPP alone is not enough');
    expect(text(section('gap'))).toContain('MPP cannot prove: for what?');
    // It fits existing protocols and hardware, and says the demo meter is not conformant.
    const fits = within(section('gap')).getByRole('heading', { name: 'Fits what is already deployed' }).parentElement;
    expect(text(fits)).toContain('No new hardware.');
    expect(text(fits)).toContain('No new payment protocol.');
    expect(text(fits)).toContain('not certified and not OCPP or OCMF conformant');
    // The brand reads "UsagePay on Stellar", never "by Stellar".
    expect(text(document.querySelector('.topbar .brand'))).toBe('UsagePayon Stellar');
    expect(document.querySelector('.topbar .brand sup')).not.toBeNull();
  });
});
