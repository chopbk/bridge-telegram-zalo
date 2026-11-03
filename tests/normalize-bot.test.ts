import { describe, expect, it } from 'vitest';
import { normalizeBotUpdate } from '../src/zalo/bot/adapter.js';

describe('normalizeBotUpdate', () => {
  it('parses Telegram-like Zalo Bot message', () => {
    const msg = normalizeBotUpdate({
      message: {
        message_id: 10,
        text: 'xin chao',
        chat: { id: 'user-abc' },
        from: { first_name: 'An' },
      },
    });
    expect(msg).toEqual({
      zaloUserId: 'user-abc',
      text: 'xin chao',
      displayName: 'An',
      messageId: '10',
    });
  });

  it('parses OA-style user_send_text', () => {
    const msg = normalizeBotUpdate({
      event_name: 'user_send_text',
      sender: { id: '12345' },
      message: { text: 'hello', msg_id: 'm1' },
    });
    expect(msg).toEqual({
      zaloUserId: '12345',
      text: 'hello',
      messageId: 'm1',
    });
  });

  it('returns null for unknown payload', () => {
    expect(normalizeBotUpdate({ foo: 1 })).toBeNull();
    expect(normalizeBotUpdate(null)).toBeNull();
  });
});
