export interface User {
  id: string;
  username: string;
  role: 'MASTER' | 'JOGADOR';
  blocked: boolean;
  mustChangePassword: boolean;
  createdAt: string;
}

export interface Session {
  user: User;
  csrfToken: string;
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

interface Options {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  csrfToken?: string;
  signal?: AbortSignal;
}

export type Request = <T>(path: string, options?: Omit<Options, 'csrfToken'>) => Promise<T>;

export async function api<T>(path: string, options: Options = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const multipart = options.body instanceof FormData;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') {
    // The browser supplies the multipart boundary; JSON remains the default.
    if (!multipart) headers['Content-Type'] = 'application/json';
    headers['X-Requested-With'] = 'XMLHttpRequest';
    if (options.csrfToken) headers['X-CSRF-Token'] = options.csrfToken;
  }

  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: options.signal,
      ...(method !== 'GET' ? { body: multipart ? options.body as FormData : JSON.stringify(options.body ?? {}) } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'Não foi possível conectar ao serviço. Verifique a conexão e tente novamente.');
  }

  if (!response.ok) {
    let message = response.status === 429
      ? 'Muitas tentativas. Aguarde alguns minutos antes de tentar novamente.'
      : 'Não foi possível concluir a solicitação. Tente novamente.';
    if (response.status === 401) message = 'Nome de usuário ou senha inválidos, ou sessão encerrada.';
    if (response.status === 403) message = 'Você não tem permissão para realizar esta ação.';
    try {
      const result: unknown = await response.json();
      if (typeof result === 'object' && result !== null && 'message' in result) {
        const detail = result.message;
        if (typeof detail === 'string') message = detail;
        else if (Array.isArray(detail) && detail.every((item) => typeof item === 'string')) {
          message = detail.join(' ');
        }
      }
    } catch {
      // Proxy and connection failures can return a non-JSON response.
    }
    throw new ApiError(response.status, message);
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Ocorreu um erro inesperado. Tente novamente.';
}
