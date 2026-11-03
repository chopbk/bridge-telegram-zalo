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

  it('parses getUpdates-style message.text.received payload', () => {
    const msg = normalizeBotUpdate({
      event_name: 'message.text.received',
      message: {
        message_id: '2d758cb5e222177a4e35',
        text: 'Xin chào',
        from: { id: '6ede9afa66b88fe6d6a9', display_name: 'Ted' },
        chat: { id: '6ede9afa66b88fe6d6a9', chat_type: 'PRIVATE' },
      },
    });
    expect(msg).toEqual({
      zaloUserId: '6ede9afa66b88fe6d6a9',
      text: 'Xin chào',
      displayName: 'Ted',
      messageId: '2d758cb5e222177a4e35',
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
