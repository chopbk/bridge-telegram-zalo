declare module 'zca-js' {
  export enum ThreadType {
    User = 0,
    Group = 1,
  }

  export enum LoginQRCallbackEventType {
    QRCodeGenerated = 0,
    QRCodeExpired = 1,
    QRCodeScanned = 2,
    QRCodeDeclined = 3,
    GotLoginInfo = 4,
  }

  export type Credentials = {
    cookie: unknown;
    imei: string;
    userAgent: string;
    language?: string;
  };

  export type AttachmentSource =
    | string
    | {
        data: Buffer;
        filename: `${string}.${string}`;
        metadata: {
          totalSize: number;
          width?: number;
          height?: number;
        };
      };

  export type MessageContent = {
    msg: string;
    attachments?: AttachmentSource | AttachmentSource[];
    ttl?: number;
  };

  export type ImageMetadataGetterResponse = {
    width: number;
    height: number;
    size: number;
  } | null;

  export type ImageMetadataGetter = (
    filePath: string,
  ) => Promise<ImageMetadataGetterResponse>;

  export type ZaloOptions = {
    selfListen?: boolean;
    checkUpdate?: boolean;
    logging?: boolean;
    imageMetadataGetter?: ImageMetadataGetter;
  };

  export type ZaloFriend = {
    userId: string;
    username?: string;
    displayName?: string;
    zaloName?: string;
    lastActionTime?: number;
  };

  export type SendMessageResult = {
    message?: { msgId?: string | number } | null;
    attachment?: Array<{ msgId?: string | number }>;
  };

  export type API = {
    sendMessage: (
      message: string | MessageContent,
      threadId: string,
      type?: ThreadType,
    ) => Promise<SendMessageResult>;
    getAllFriends: (count?: number, page?: number) => Promise<ZaloFriend[]>;
    getAllGroups: () => Promise<{ gridVerMap?: Record<string, string> }>;
    getGroupInfo: (groupId: string | string[]) => Promise<{
      gridInfoMap?: Record<
        string,
        { name?: string; totalMember?: number; createdTime?: number }
      >;
    }>;
    getUnreadMark?: () => Promise<{
      data?: {
        convsUser?: Array<{ id?: number | string; fromUid?: number | string; ts?: number }>;
        convsGroup?: Array<{ id?: number | string; fromUid?: number | string; ts?: number }>;
      };
    }>;
    getPinConversations?: () => Promise<{ conversations?: string[] }>;
    getUserInfo?: (
      userId: string | string[],
    ) => Promise<{
      unchanged_profiles?: Record<string, { displayName?: string; zaloName?: string }>;
      changed_profiles?: Record<string, { displayName?: string; zaloName?: string }>;
    }>;
    listener: {
      on: (event: 'message', handler: (message: ZaloListenerMessage) => void) => void;
      start: () => void;
      stop: () => void;
    };
  };

  export type ZaloListenerMessage = {
    type: ThreadType;
    isSelf?: boolean;
    threadId: string;
    data: {
      content?: unknown;
      msgId?: string | number;
      msgType?: string;
      dName?: string;
    };
  };

  export class Zalo {
    constructor(options?: ZaloOptions);
    login(credentials: Credentials): Promise<API>;
    loginQR(
      options: Record<string, unknown>,
      callback: (event: LoginQRCallbackEvent) => void,
    ): Promise<API>;
  }

  export type LoginQRCallbackEvent =
    | {
        type: LoginQRCallbackEventType.QRCodeGenerated;
        actions: { saveToFile: (path: string) => Promise<void>; retry: () => void };
        data: unknown;
      }
    | {
        type: LoginQRCallbackEventType.QRCodeScanned;
        data: { display_name?: string };
        actions: { retry: () => void };
      }
    | {
        type: LoginQRCallbackEventType.QRCodeExpired;
        actions: { retry: () => void };
        data: unknown;
      }
    | {
        type: LoginQRCallbackEventType.QRCodeDeclined;
        data: unknown;
        actions: { retry: () => void };
      }
    | {
        type: LoginQRCallbackEventType.GotLoginInfo;
        data: {
          cookie: Credentials['cookie'];
          imei: string;
          userAgent: string;
        };
        actions: { retry: () => void };
      };
}
