import { strict as assert } from 'assert';

describe('E2E matrix completion fixture', function () {
  it('fails in the Chrome Webpack matrix', function () {
    assert.notEqual(
      process.env.TEST_SUITE_NAME,
      'test-e2e-chrome-webpack',
      'Intentional merge-queue matrix failure',
    );
  });
});
