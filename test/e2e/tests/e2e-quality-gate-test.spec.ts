import { strict as assert } from 'assert';

describe('E2E matrix completion fixture', function () {
  it('fails in the Chrome Webpack matrix', function () {
    assert.notEqual(
      process.env.GITHUB_EVENT_NAME === 'merge_group' &&
        process.env.TEST_SUITE_NAME === 'test-e2e-chrome-webpack',
      true,
      'Intentional merge-queue matrix failure',
    );
  });
});
