import { describe, expect, it } from 'vitest';
import { parseIdList } from '../src/config/env.js';

describe('parseIdList', () => {
  it('parses comma-separated ids', () => {
    expect(parseIdList('111,222, 333')).toEqual([111, 222, 333]);
  });

  it('dedupes and accepts newlines/semicolons', () => {
    expect(parseIdList('111;111\n222')).toEqual([111, 222]);
  });

  it('keeps negative channel ids', () => {
    expect(parseIdList('-1001, -1002')).toEqual([-1001, -1002]);
  });
});
