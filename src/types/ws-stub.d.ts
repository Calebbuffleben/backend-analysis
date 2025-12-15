declare module 'ws' {
  import type { IncomingMessage } from 'http';
  import type { Socket } from 'net';
  export class WebSocket {
    send(data: string | ArrayBufferLike | Buffer, cb?: (err?: Error) => void): void;
    close(code?: number, reason?: string): void;
    on(
      event: 'message',
      listener: (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void,
    ): this;
    on(event: 'close', listener: () => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
  }
  export class WebSocketServer /* extends EventEmitter */ {
    constructor(options: { noServer?: boolean });
    handleUpgrade(
      request: IncomingMessage,
      socket: Socket,
      head: Buffer,
      cb: (ws: WebSocket) => void,
    ): void;
    emit(event: 'connection', ws: WebSocket, request: IncomingMessage): boolean;
    on(event: 'connection', listener: (ws: WebSocket, request: IncomingMessage) => void): this;
  }
}
