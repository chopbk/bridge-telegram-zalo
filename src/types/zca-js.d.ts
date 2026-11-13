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

  export type ZaloTextStyle = {
    start: number;
    len: number;
    st: string;
    indentSize?: number;
  };

  export type MessageContent = {
    msg: string;
    styles?: ZaloTextStyle[];
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
    message?: { msgId?: string | number; cliMsgId?: string | number } | null;
    attachment?: Array<{ msgId?: string | number; cliMsgId?: string | number }>;
  };

  export type UndoPayload = {
    msgId: string | number;
    cliMsgId: string | number;
  };

  export type ZaloUndoEvent = {
    isSelf?: boolean;
    isGroup?: boolean;
    threadId: string;
    data: {
      msgId?: string | number;
      cliMsgId?: string | number;
      uidFrom?: string | number;
      idTo?: string | number;
      content?: {
        globalMsgId?: string | number;
        cliMsgId?: string | number;
        deleteMsg?: number;
      };
    };
  };

  export type API = {
    sendMessage: (
      message: string | MessageContent,
      threadId: string,
      type?: ThreadType,
    ) => Promise<SendMessageResult>;
    undo: (
      payload: UndoPayload,
      threadId: string,
      type?: ThreadType,
    ) => Promise<{ status?: number }>;
    deleteMessage: (
      dest: {
        data: { cliMsgId: string; msgId: string; uidFrom: string };
        threadId: string;
        type?: ThreadType;
      },
      onlyMe?: boolean,
    ) => Promise<{ status?: number }>;
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
    getGroupChatHistory?: (
      groupId: string,
      count?: number,
    ) => Promise<{
      groupMsgs?: Array<{ data?: { ts?: string | number }; ts?: string | number }>;
    }>;
    getUserInfo?: (
      userId: string | string[],
    ) => Promise<{
      unchanged_profiles?: Record<string, { displayName?: string; zaloName?: string }>;
      changed_profiles?: Record<string, { displayName?: string; zaloName?: string }>;
    }>;
    listener: {
      on: {
        (event: 'message', handler: (message: ZaloListenerMessage) => void): void;
        (event: 'undo', handler: (undo: ZaloUndoEvent) => void): void;
      };
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
      cliMsgId?: string | number;
      msgType?: string;
      dName?: string;
      ts?: string | number;
      uidFrom?: string | number;
      idTo?: string | number;
      propertyExt?: {
        color?: number;
        size?: number;
        type?: number;
        subType?: number;
        ext?: string;
      };
      mentions?: Array<{ uid?: string; pos?: number; len?: number; type?: number }>;
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
