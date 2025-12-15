import {
  WebSocketGateway as NestWebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import type { FeedbackSeverity } from '../feedback/feedback.types';

@NestWebSocketGateway({
  cors: {
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps or curl requests)
      if (!origin) return callback(null, true);
      // Allow any origin in development, or specific ones in production
      // For this project, we'll accept all for simplicity but ideally restrict to meet.google.com
      callback(null, true);
    },
    credentials: true,
  },
  namespace: '/',
})
export class AppWebSocketGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(AppWebSocketGateway.name);
  private connectedClients = new Map<string, Socket>();

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
    this.connectedClients.set(client.id, client);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
    this.connectedClients.delete(client.id);
  }

  @SubscribeMessage('message')
  handleMessage(@MessageBody() data: string, @ConnectedSocket() client: Socket): string {
    this.logger.log(`Message received from ${client.id}: ${data}`);
    this.server.emit('message', { clientId: client.id, message: data });
    return 'Message received';
  }

  @SubscribeMessage('join-room')
  handleJoinRoom(@MessageBody() room: string, @ConnectedSocket() client: Socket): void {
    client.join(room);
    this.logger.log(`Client ${client.id} joined room: ${room}`);
    this.server.to(room).emit('user-joined', { clientId: client.id, room });
  }

  @SubscribeMessage('leave-room')
  handleLeaveRoom(@MessageBody() room: string, @ConnectedSocket() client: Socket): void {
    client.leave(room);
    this.logger.log(`Client ${client.id} left room: ${room}`);
    this.server.to(room).emit('user-left', { clientId: client.id, room });
  }
}
