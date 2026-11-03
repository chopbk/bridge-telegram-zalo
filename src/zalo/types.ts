export type ZaloMode = 'bot' | 'personal';

export type NormalizedInbound = {
  zaloUserId: string;
  /** Empty when unsupportedKind is set */
  text: string;
  displayName?: string;
  messageId?: string;
  /** Non-text inbound (image, file, voice, …) */
  unsupportedKind?: string;
};

export type ZaloSendResult = {
  messageId: string;
};

export type ZaloThreadKind = 'user' | 'group';

export type ZaloContact = {
  zaloUserId: string;
  displayName: string;
  zaloName?: string;
  /** Epoch ms of last interaction when known */
  lastActiveAt?: number;
  kind?: ZaloThreadKind;
  memberCount?: number;
};

export type SendTextOptions = {
  threadKind?: ZaloThreadKind;
};

export interface ZaloAdapter {
  readonly mode: ZaloMode;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendText(userId: string, text: string, opts?: SendTextOptions): Promise<ZaloSendResult>;
  onInbound(handler: (msg: NormalizedInbound) => void | Promise<void>): void;
  /** Personal: danh sách bạn bè Zalo. Bot: có thể không hỗ trợ. */
  listContacts?(): Promise<ZaloContact[]>;
  /** Personal: chat gần đây (1-1 + group). */
  listRecentChats?(limit?: number): Promise<ZaloContact[]>;
  /** Personal: đoán id là user hay group. */
  resolveThreadKind?(zaloId: string): Promise<ZaloThreadKind>;
}
