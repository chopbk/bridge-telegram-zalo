import { describe, expect, it } from 'vitest';
import { isRegisterIntent, isUnsubscribeIntent } from '../src/bridge/registration.js';

describe('registration intents', () => {
  it('detects register keywords', () => {
    expect(isRegisterIntent('đăng ký')).toBe(true);
    expect(isRegisterIntent('Dang Ky')).toBe(true);
    expect(isRegisterIntent('/register')).toBe(true);
    expect(isRegisterIntent('/start')).toBe(true);
    expect(isRegisterIntent('xin đăng ký nhận tin')).toBe(true);
    expect(isRegisterIntent('hello')).toBe(false);
  });

  it('detects unsubscribe keywords', () => {
    expect(isUnsubscribeIntent('hủy đăng ký')).toBe(true);
    expect(isUnsubscribeIntent('Huy dang ky')).toBe(true);
    expect(isUnsubscribeIntent('/stop')).toBe(true);
    expect(isUnsubscribeIntent('đăng ký')).toBe(false);
  });
});
