export interface PromiseChain {
  previous: Promise<void>;
  add<T>(_task: () => Promise<T>): Promise<T>;
}

/**
 * SDK-004: тип для client.session.* методов, используемых в рантайме.
 * Изолирует зависимость от полного OpencodeClient — тесты могут замокать.
 */
export interface OpenCodeSessionClient {
  messages(options: {
    path: { id: string };
    query?: { limit?: number; offset?: number };
  }): Promise<{ data: Array<{ id: string; parts: Array<{ type: string; status?: string }> }> }>;
  prompt(options: {
    path: { id: string };
    body: {
      content: string;
      parts: Array<{ type: string; noReply?: boolean; title?: string; text?: string }>;
    };
  }): Promise<{ data: unknown; error?: { message: string } }>;
  list(options?: {
    query?: { limit?: number };
  }): Promise<{ data: Array<{ id: string; title?: string }> }>;
}
