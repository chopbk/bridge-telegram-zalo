import { describe, expect, it } from 'vitest';
import {
  captionFromPhotoContent,
  extractInboundImages,
} from '../src/zalo/personal/photo.js';

describe('extractInboundImages', () => {
  it('extracts hd url from chat.photo params', () => {
    const content = {
      title: 'Caption đây',
      description: '',
      href: 'https://cdn.example/normal.jpg',
      thumb: 'https://cdn.example/thumb.jpg',
      childnumber: 0,
      action: '',
      params: JSON.stringify({
        hd: 'https://cdn.example/hd.jpg',
        width: 1200,
        height: 800,
      }),
      type: 'photo',
    };
    const images = extractInboundImages(content, 'chat.photo');
    expect(images).toEqual([{ url: 'https://cdn.example/hd.jpg' }]);
    expect(captionFromPhotoContent(content)).toBe('Caption đây');
  });

  it('falls back to href when no params hd', () => {
    const content = {
      href: 'https://cdn.example/a.jpg',
      thumb: 'https://cdn.example/t.jpg',
      params: '{}',
    };
    expect(extractInboundImages(content, 'chat.photo')).toEqual([
      { url: 'https://cdn.example/a.jpg' },
    ]);
  });

  it('ignores non-photo msgType', () => {
    const content = {
      href: 'https://cdn.example/a.jpg',
      thumb: 'https://cdn.example/t.jpg',
      params: '{}',
    };
    expect(extractInboundImages(content, 'chat.voice')).toBeNull();
  });

  it('heuristic without msgType when href+thumb present', () => {
    const content = {
      href: 'https://cdn.example/a.jpg',
      thumb: 'https://cdn.example/t.jpg',
    };
    expect(extractInboundImages(content)).toEqual([{ url: 'https://cdn.example/a.jpg' }]);
  });
});
