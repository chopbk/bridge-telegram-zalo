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

export type ZaloContact = {
  zaloUserId: string;
  displayName: string;
  zaloName?: string;
};

export interface ZaloAdapter {
  readonly mode: ZaloMode;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendText(userId: string, text: string): Promise<ZaloSendResult>;
  onInbound(handler: (msg: NormalizedInbound) => void | Promise<void>): void;
  /** Personal: danh sách bạn bè Zalo. Bot: có thể không hỗ trợ. */
  listContacts?(): Promise<ZaloContact[]>;
}
