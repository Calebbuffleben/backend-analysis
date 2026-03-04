/**
 * Fallback for `process` when @types/node is not resolved (e.g. before pnpm install).
 * Remove or leave as-is once @types/node is installed; TypeScript will prefer @types/node when present.
 */
declare namespace NodeJS {
  interface ProcessEnv {
    [key: string]: string | undefined;
  }
}
declare const process: { env: NodeJS.ProcessEnv };
