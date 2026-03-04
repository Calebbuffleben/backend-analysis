/**
 * Fallback when @nestjs/event-emitter is not resolved (e.g. before pnpm install).
 * Remove once node_modules is installed and types resolve from the package.
 */
declare module '@nestjs/event-emitter' {
  export function OnEvent(event: string): (target: unknown, propertyKey?: string, descriptor?: PropertyDescriptor) => void;
  export function OnEvent(event: string, options: { async?: boolean }): (target: unknown, propertyKey?: string, descriptor?: PropertyDescriptor) => void;
  export class EventEmitter2 {
    emit(event: string, ...args: unknown[]): boolean;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }
  export const EventEmitterModule: {
    forRoot(options?: unknown): unknown;
  };
}
