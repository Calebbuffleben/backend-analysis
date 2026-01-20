declare module 'ioredis' {
  // Minimal typing shim for local builds in environments where node_modules isn't installed yet.
  // Full types will be provided by the actual dependency when installed.
  export default class Redis {
    constructor(url: string, opts?: Record<string, unknown>);
    xadd(...args: unknown[]): Promise<unknown>;
  }
}

