/**
 * Fallback when @nestjs/common is not resolved (e.g. before pnpm install).
 * Remove once node_modules is installed and types resolve from the package.
 */
declare module '@nestjs/common' {
  export function Injectable(): (target: unknown) => void;
  export class Logger {
    constructor(context?: string);
    log(message: unknown, ...optionalParams: unknown[]): void;
    error(message: unknown, ...optionalParams: unknown[]): void;
    warn(message: unknown, ...optionalParams: unknown[]): void;
    debug(message: unknown, ...optionalParams: unknown[]): void;
  }
  export function OnEvent(event: string, options?: { async?: boolean }): (target: unknown, propertyKey?: string, descriptor?: PropertyDescriptor) => void;
  export function Inject(token: string | symbol): (target: unknown, propertyKey?: string | symbol, parameterIndex?: number) => void;
  export function Optional(): (target: unknown, propertyKey?: string | symbol, parameterIndex?: number) => void;
  export function Controller(prefix?: string): (target: unknown) => void;
  export function Get(path?: string): (target: unknown, propertyKey?: string, descriptor?: PropertyDescriptor) => void;
  export function Param(id: string): (target: unknown, propertyKey?: string | symbol, parameterIndex?: number) => void;
  export function ValidationPipe(options?: unknown): unknown;
  export interface OnApplicationBootstrap {
    onApplicationBootstrap(): void | Promise<void>;
  }
  export interface OnApplicationShutdown {
    onApplicationShutdown(signal?: string): void | Promise<void>;
  }
  export interface OnModuleDestroy {
    onModuleDestroy(): void | Promise<void>;
  }
  export const Module: (metadata: unknown) => (target: unknown) => void;
}
