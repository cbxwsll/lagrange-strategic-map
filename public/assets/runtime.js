export function createRuntime(moduleUrl, pageUrl) {
  const base = new URL('../', moduleUrl);
  const page = new URL(pageUrl);
  const apiBase = new URL('api/v1/', base).toString().replace(/\/$/, '');
  const ws = new URL('ws', base);
  ws.protocol = page.protocol === 'https:' ? 'wss:' : 'ws:';
  return {
    base,
    apiBase,
    wsUrl: ws.toString(),
    page(name, parameters = {}) {
      const url = new URL(name, base);
      for (const [key, value] of Object.entries(parameters)) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
      }
      return url.toString();
    }
  };
}

export const runtime = typeof window === 'undefined'
  ? null
  : createRuntime(import.meta.url, window.location.href);
