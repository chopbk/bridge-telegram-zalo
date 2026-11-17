import { describe, expect, it } from 'vitest';
import { extractRtfMessage } from '../src/zalo/personal/rtf.js';

describe('extractRtfMessage', () => {
  it('extracts rtf title + styles from params', () => {
    const content = {
      title: '🏁 DÍNH STP — Lúa mì (BÁN)\n\nPnL: +0.25',
      description: '',
      href: '',
      thumb: '',
      action: 'rtf',
      params: JSON.stringify({
        styles: [
          { start: 3, len: 10, st: 'i' },
          { start: 20, len: 5, st: 'b' },
        ],
        ver: 0,
      }),
      type: '',
    };
    const got = extractRtfMessage(content);
    expect(got?.text).toContain('DÍNH STP');
    expect(got?.styles).toEqual([
      { start: 3, len: 10, st: 'i' },
      { start: 20, len: 5, st: 'b' },
    ]);
  });

  it('ignores non-rtf objects', () => {
    expect(
      extractRtfMessage({
        title: 'Example',
        href: 'https://example.com',
        action: '',
      }),
    ).toBeNull();
  });

  it('ignores rtf without title text', () => {
    expect(extractRtfMessage({ action: 'rtf', title: '  ', href: '' })).toBeNull();
  });
});
