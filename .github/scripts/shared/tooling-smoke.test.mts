import { pickSmokeFile } from './tooling-smoke.mts';

const files = [
  'app/scripts/background.ts',
  'shared/types/globals.d.ts',
  'shared/lib/Numeric.test.ts',
  'shared/lib/__mocks__/mock.ts',
  'shared/lib/Numeric.ts',
  'ui/components/button/button.stories.tsx',
  'ui/components/button/button.test.tsx',
  'ui/components/button/button.tsx',
];

describe('pickSmokeFile', () => {
  it('picks the first real source file under shared or ui', () => {
    expect(pickSmokeFile(files, '.ts')).toBe('shared/lib/Numeric.ts');
    expect(pickSmokeFile(files, '.tsx')).toBe(
      'ui/components/button/button.tsx',
    );
  });

  it('returns undefined when there is no candidate', () => {
    expect(pickSmokeFile(['app/scripts/background.ts'], '.ts')).toBeUndefined();
  });
});
