import { describe, expect, it } from 'vitest';
import {
  parseZaloPropertyStyles,
  telegramEntitiesToZaloStyles,
  zaloStylesToTelegramHtml,
} from '../src/bridge/format.js';

describe('parseZaloPropertyStyles', () => {
  it('parses styles from propertyExt.ext JSON string', () => {
    const styles = parseZaloPropertyStyles({
      color: 0,
      size: 0,
      type: 0,
      subType: 0,
      ext: JSON.stringify({
        styles: [
          { start: 0, len: 4, st: 'b' },
          { start: 5, len: 6, st: 'i' },
        ],
        ver: 0,
      }),
    });
    expect(styles).toEqual([
      { start: 0, len: 4, st: 'b' },
      { start: 5, len: 6, st: 'i' },
    ]);
  });
});

describe('zaloStylesToTelegramHtml', () => {
  it('wraps bold and italic ranges', () => {
    const html = zaloStylesToTelegramHtml('Bold italic', [
      { start: 0, len: 4, st: 'b' },
      { start: 5, len: 6, st: 'i' },
    ]);
    expect(html).toBe('<b>Bold</b> <i>italic</i>');
  });

  it('escapes html in plain text', () => {
    expect(zaloStylesToTelegramHtml('a<b>&c', [])).toBe('a&lt;b&gt;&amp;c');
  });
});

describe('telegramEntitiesToZaloStyles', () => {
  it('maps telegram entities to zalo styles', () => {
    expect(
      telegramEntitiesToZaloStyles('Hello world', [
        { type: 'bold', offset: 0, length: 5 },
        { type: 'italic', offset: 6, length: 5 },
      ]),
    ).toEqual([
      { start: 0, len: 5, st: 'b' },
      { start: 6, len: 5, st: 'i' },
    ]);
  });

  it('ignores unsupported entity types', () => {
    expect(
      telegramEntitiesToZaloStyles('code', [{ type: 'code', offset: 0, length: 4 }]),
    ).toEqual([]);
  });
});
