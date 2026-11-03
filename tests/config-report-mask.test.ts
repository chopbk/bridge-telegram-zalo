import { describe, expect, it } from 'vitest';
import { maskSecret } from '../src/telegram/config-report.js';

describe('maskSecret', () => {
  it('masks long tokens', () => {
    expect(maskSecret('1234567890abcdef', 4, 4)).toBe('1234…cdef');
  });
  it('handles empty', () => {
    expect(maskSecret(undefined)).toBe('(empty)');
    expect(maskSecret('')).toBe('(empty)');
  });
});
