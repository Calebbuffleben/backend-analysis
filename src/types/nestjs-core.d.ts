/**
 * Fallback when @nestjs/core is not resolved (e.g. before pnpm install).
 */
declare module '@nestjs/core' {
  export class NestFactory {
    static create(module: unknown, options?: unknown): Promise<{ listen(port: number): Promise<unknown> }>;
  }
}
