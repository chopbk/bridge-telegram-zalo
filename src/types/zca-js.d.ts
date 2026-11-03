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

  export type ZaloFriend = {
    userId: string;
    username?: string;
    displayName?: string;
    zaloName?: string;
  };

  export type API = {
    sendMessage: (
      message: string | { msg: string },
      threadId: string,
      type?: ThreadType,
    ) => Promise<{ message?: { msgId?: string | number } }>;
    getAllFriends: (count?: number, page?: number) => Promise<ZaloFriend[]>;
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
      dName?: string;
    };
  };

  export class Zalo {
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
