export interface ProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
}

export interface ProcessRunner {
  (command: string, args: string[], options?: ProcessOptions): Promise<ProcessResult>;
}
