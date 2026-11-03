export type ZaloMode = 'bot' | 'personal';

export type InboundImage = {
  /** Direct download URL (Zalo CDN) */
  url: string;
};

export type NormalizedInbound = {
  zaloUserId: string;
  /** Empty when only images / unsupported */
  text: string;
  displayName?: string;
  messageId?: string;
  /** Photo(s) from Zalo — prefer over unsupportedKind */
  images?: InboundImage[];
  /** Non-text inbound (file, voice, …) when images not extracted */
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

/** Buffer attachment ready for zca-js sendMessage */
export type ZaloImageAttachment = {
  data: Buffer;
  filename: `${string}.${string}`;
  metadata: {
    totalSize: number;
    width: number;
    height: number;
  };
};

export type SendImagesOptions = SendTextOptions & {
  caption?: string;
};

export type ListRecentChatsOptions = {
  /** Chỉ lấy user / group / cả hai */
  focus?: 'all' | 'user' | 'group';
  /**
   * Với group thiếu timestamp: gọi getGroupChatHistory(1) để lấy tin cuối.
   * Mặc định true khi focus=group.
   */
  probeGroupHistory?: boolean;
};

export interface ZaloAdapter {
  readonly mode: ZaloMode;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendText(userId: string, text: string, opts?: SendTextOptions): Promise<ZaloSendResult>;
  /** Gửi 1 hoặc nhiều ảnh (personal: attachments; bot: lần lượt nếu API hỗ trợ) */
  sendImages?(
    userId: string,
    images: ZaloImageAttachment[],
    opts?: SendImagesOptions,
  ): Promise<ZaloSendResult>;
  onInbound(handler: (msg: NormalizedInbound) => void | Promise<void>): void;
  /** Personal: danh sách bạn bè Zalo. Bot: có thể không hỗ trợ. */
  listContacts?(): Promise<ZaloContact[]>;
  /** Personal: chat gần đây (1-1 + group), sắp theo hoạt động thật. */
  listRecentChats?(
    limit?: number,
    opts?: ListRecentChatsOptions,
  ): Promise<ZaloContact[]>;
  /** Personal: đoán id là user hay group. */
  resolveThreadKind?(zaloId: string): Promise<ZaloThreadKind>;
}
