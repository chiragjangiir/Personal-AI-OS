export interface DashscopeProvider {
  requireBeijing(): void;
  postJSON(path: string, body: unknown, maximumBytes: number, signal?: AbortSignal): Promise<unknown>;
  [key: string]: unknown;
}
export function createDashscopeProvider(options: {
  config: {audioRealtimeBaseUrl: string; dashscopeApiKey: string; region: string};
  fetcher?: typeof fetch;
}): DashscopeProvider;
