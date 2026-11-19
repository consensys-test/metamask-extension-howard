import {
  buildPreapprovedEnv,
  parsePreapproved,
  parseQuarantined,
  runWithBypass,
  type CommandResult,
} from './age-gate.mts';

describe('parseQuarantined', () => {
  it('reads plain and scoped names once each', () => {
    const output = [
      '➤ YN0016: │ is-odd@npm:3.0.1: All versions satisfying "3.0.1" are quarantined',
      '➤ YN0016: │ @scope/pkg@npm:^1.2.0: All versions satisfying "^1.2.0" are quarantined',
      '➤ YN0016: │ is-odd@npm:^3.0.0: All versions satisfying "^3.0.0" are quarantined',
      '➤ YN0000: · Failed with errors in 0s 213ms',
    ].join('\n');

    expect(parseQuarantined(output)).toStrictEqual(['is-odd', '@scope/pkg']);
  });

  it('ignores output without quarantine errors', () => {
    expect(parseQuarantined('➤ YN0000: · Done')).toStrictEqual([]);
  });
});

describe('parsePreapproved', () => {
  it('reads quoted and bare entries and stops at the next key', () => {
    const yarnrc = [
      'npmMinimalAgeGate: 4320',
      '',
      'npmPreapprovedPackages:',
      "  - '@metamask/*'",
      '  # comment',
      '  - lavamoat',
      '  - "extension-port-stream"',
      '',
      'plugins:',
      '  - path: x',
    ].join('\r\n');

    expect(parsePreapproved(yarnrc)).toStrictEqual([
      '@metamask/*',
      'lavamoat',
      'extension-port-stream',
    ]);
  });

  it('returns an empty list when the key is absent', () => {
    expect(parsePreapproved('a: 1\n')).toStrictEqual([]);
  });
});

describe('buildPreapprovedEnv', () => {
  it('keeps the existing entries, adds new ones and drops duplicates', () => {
    expect(
      buildPreapprovedEnv(['@metamask/*', 'lavamoat'], ['x', 'lavamoat']),
    ).toBe('@metamask/*,lavamoat,x');
  });
});

describe('runWithBypass', () => {
  const quarantine = (...names: string[]): CommandResult => ({
    status: 1,

    stdout: names

      .map(
        (name) =>
          `➤ YN0016: │ ${name}@npm:^1.0.0: All versions satisfying "^1.0.0" are quarantined`,
      )

      .join('\n'),

    stderr: '',
  });

  const ok: CommandResult = { status: 0, stdout: '', stderr: '' };

  const existing = ['@metamask/*'];

  /** Runs `runWithBypass` against scripted results and records every call. */

  function setup(
    results: CommandResult[],

    options: {
      allowed?: string[];

      preapprove?: string[];

      maxRounds?: number;
    } = {},
  ) {
    const envs: (string | undefined)[] = [];

    const messages: string[] = [];

    const outcome = runWithBypass({
      run: (preapproved) => {
        envs.push(preapproved);

        const result = results[envs.length - 1];

        if (!result) {
          throw new Error('The command ran more often than scripted.');
        }

        return result;
      },

      existing,

      maxRounds: 5,

      ...options,

      info: (message) => messages.push(message),

      warn: (message) => messages.push(message),
    });

    return { outcome, envs, messages };
  }

  it('runs once without a preapproval when nothing is quarantined', () => {
    const { outcome, envs } = setup([ok]);

    expect(outcome).toStrictEqual({
      exitCode: 0,

      bypassed: [],

      succeeded: true,
    });

    expect(envs).toStrictEqual([undefined]);
  });

  it('retries with the quarantined package preapproved, keeping the existing entries', () => {
    const { outcome, envs } = setup([quarantine('is-odd'), ok]);

    expect(envs).toStrictEqual([undefined, '@metamask/*,is-odd']);

    expect(outcome).toStrictEqual({
      exitCode: 0,

      bypassed: ['is-odd'],

      succeeded: true,
    });
  });

  it('preapproves packages from the first run', () => {
    const { outcome, envs } = setup([ok], { preapprove: ['@scope/a', 'b'] });

    expect(envs).toStrictEqual(['@metamask/*,@scope/a,b']);

    expect(outcome.bypassed).toStrictEqual(['@scope/a', 'b']);

    expect(outcome.succeeded).toBe(true);
  });

  it('adds packages across rounds', () => {
    const { outcome, envs } = setup([
      quarantine('a'),

      quarantine('a', 'b'),

      ok,
    ]);

    expect(envs.at(-1)).toBe('@metamask/*,a,b');

    expect(outcome.bypassed).toStrictEqual(['a', 'b']);
  });

  it('stops with exit code 2 when a quarantined package is not allowed', () => {
    const { outcome, envs, messages } = setup([quarantine('a', 'evil'), ok], {
      allowed: ['a'],
    });

    expect(outcome).toMatchObject({ exitCode: 2, succeeded: false });

    expect(envs).toHaveLength(1);

    expect(messages.join('')).toContain('not allowed to bypass: evil');
  });

  it('stops when a preapproved package is still quarantined', () => {
    const { outcome, messages } = setup([quarantine('a'), quarantine('a')]);

    expect(outcome).toMatchObject({ exitCode: 1, succeeded: false });

    expect(messages.join('')).toContain('Still quarantined after preapproval');
  });

  it('gives up after the round limit', () => {
    const { outcome, envs, messages } = setup(
      [quarantine('a'), quarantine('b'), quarantine('c')],

      { maxRounds: 1 },
    );

    expect(envs).toHaveLength(2);

    expect(outcome).toMatchObject({ exitCode: 1, succeeded: false });

    expect(messages.join('')).toContain('Still quarantined after 1 rounds');
  });

  it('returns a failure that is not about quarantine as is, without marking it succeeded', () => {
    const { outcome } = setup([{ status: 3, stdout: 'boom', stderr: '' }], {
      preapprove: ['a'],
    });

    expect(outcome).toStrictEqual({
      exitCode: 3,

      bypassed: ['a'],

      succeeded: false,
    });
  });

  it('treats a missing exit status as a failure', () => {
    const { outcome } = setup([{ status: null, stdout: '', stderr: '' }]);

    expect(outcome.exitCode).toBe(1);
  });
});
