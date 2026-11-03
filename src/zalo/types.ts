export type ZaloMode = 'bot' | 'personal';

export type NormalizedInbound = {
  zaloUserId: string;
  text: string;
  displayName?: string;
  messageId?: string;
};

export type ZaloSendResult = {
  messageId: string;
};

export interface ZaloAdapter {
  readonly mode: ZaloMode;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendText(userId: string, text: string): Promise<ZaloSendResult>;
  onInbound(handler: (msg: NormalizedInbound) => void | Promise<void>): void;
}
