import {
  buildPreapprovedEnv,
  parsePreapproved,
  parseQuarantined,
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
