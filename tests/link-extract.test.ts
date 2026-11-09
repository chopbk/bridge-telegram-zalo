import { describe, expect, it } from 'vitest';
import { extractLinkAttachment, formatLinkText } from '../src/zalo/personal/link.js';

describe('extractLinkAttachment', () => {
  it('extracts link preview with title + href + thumb', () => {
    const content = {
      title: 'Example Domain',
      description: 'This domain is for use in examples',
      href: 'https://example.com/page',
      thumb: 'https://cdn.example/preview.jpg',
      type: '',
    };
    expect(extractLinkAttachment(content, 'webchat')).toEqual({
      href: 'https://example.com/page',
      title: 'Example Domain',
      description: 'This domain is for use in examples',
      thumb: 'https://cdn.example/preview.jpg',
    });
  });

  it('formats text with title, description and url', () => {
    const text = formatLinkText({
      href: 'https://example.com/page',
      title: 'Example Domain',
      description: 'Desc',
    });
    expect(text).toBe('Example Domain\nDesc\nhttps://example.com/page');
  });

  it('ignores photo msgType', () => {
    const content = {
      title: 'Caption',
      href: 'https://cdn.example/a.jpg',
      thumb: 'https://cdn.example/t.jpg',
      type: 'photo',
    };
    expect(extractLinkAttachment(content, 'chat.photo')).toBeNull();
  });

  it('ignores contact recommended cards', () => {
    const content = {
      title: 'Nguyen Van A',
      description: '{"phone":"0901234567"}',
      href: 'https://zr.zaloapp.com/something',
      thumb: 'https://cdn.example/avatar.jpg',
    };
    expect(extractLinkAttachment(content, 'chat.recommended')).toBeNull();
  });

  it('accepts bare https href without title', () => {
    expect(
      extractLinkAttachment({ href: 'https://news.example/article/1' }),
    ).toEqual({
      href: 'https://news.example/article/1',
      title: undefined,
      description: undefined,
      thumb: undefined,
    });
  });
});
