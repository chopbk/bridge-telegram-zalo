function normalize(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/** Strip Vietnamese tones for keyword match fallback. */
function stripTones(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd');
}

export function isRegisterIntent(text: string): boolean {
  const t = normalize(text);
  const plain = stripTones(t);
  if (t === '/register' || plain === '/register') return true;
  if (t === '/start' || plain === '/start') return true;
  if (plain === 'dang ky' || plain === 'dangky') return true;
  return plain.includes('dang ky') || t.includes('đăng ký');
}

export function isUnsubscribeIntent(text: string): boolean {
  const t = normalize(text);
  const plain = stripTones(t);
  if (t === '/stop' || plain === '/stop') return true;
  if (plain.includes('huy dang ky') || plain.includes('huy dangky')) return true;
  return t.includes('hủy đăng ký');
}
