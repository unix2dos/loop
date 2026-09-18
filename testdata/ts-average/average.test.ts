import assert from 'node:assert/strict';
import test from 'node:test';
import { average } from './average.ts';

test('empty and null inputs return zero', () => {
  assert.equal(average([]), 0);
  assert.equal(average(null), 0);
});
test('nonempty inputs keep integer averages truncated toward zero', () => {
  assert.equal(average([2, 4, 6]), 4);
  assert.equal(average([1, 2]), 1);
  assert.equal(average([-1, -2]), -1);
  assert.equal(average([7]), 7);
});
