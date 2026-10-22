import type { Citation, ChatItem, DocItem, Message } from "./types";

const apiUrl = import.meta.env.VITE_LOCAL_API_URL || "http://localhost:8787/api";

async function call<I extends object, O>(name: string, data?: I): Promise<O> {
  let response: Response;
  try {
    response = await fetch(`${apiUrl}/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data ?? {}),
    });
  } catch {
    throw new Error("Local backend is not reachable. Start it with `npm run local`.");
  }

  const result = await response.json() as { error?: string };
  if (!response.ok) {
    throw new Error("error" in result && result.error ? result.error : `Local backend request failed (${response.status}).`);
  }
  return result as O;
}

export const api = {
  health: () => call<object, { ok: boolean; geminiConfigured: boolean }>("health"),
  upload: (data: { filename: string; contentBase64: string }) => call<typeof data, { documentId: string }>("upload", data),
  ingest: (data: { documentId: string }) => call<typeof data, { chunkCount: number }>("ingest", data),
  listDocuments: () => call<object, { documents: DocItem[] }>("documents"),
  listChats: () => call<object, { chats: ChatItem[] }>("chats"),
  getMessages: (data: { chatId: string }) => call<typeof data, { messages: Message[] }>("messages", data),
  ask: (data: { question: string; documentIds: string[]; chatId?: string }) =>
    call<typeof data, { chatId: string; answer: string; citations: Citation[] }>("ask", data),
  remove: (data: { documentId: string }) => call<typeof data, { ok: boolean }>("delete", data),
};
