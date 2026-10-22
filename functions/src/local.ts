import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI, Type } from "@google/genai";
import { extractText, getDocumentProxy } from "unpdf";

const HOST = "127.0.0.1";
const PORT = Number(process.env.LOCAL_API_PORT ?? 8787);
const CHAT_MODEL = "gemini-3.8-flash";
const EMBED_MODEL = "gemini-embedding-001";
const ENV_PATH = fileURLToPath(new URL("../../.env.local", import.meta.url));
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const TOP_K = 8;
const NOT_FOUND = "I couldn't find this information in your uploaded documents.";
const DATA_DIR = fileURLToPath(new URL("../../data/", import.meta.url));
const UPLOAD_DIR = fileURLToPath(new URL("../../data/uploads/", import.meta.url));
const DB_PATH = fileURLToPath(new URL("../../data/db.json", import.meta.url));

interface Chunk {
  text: string;
  pageNumber: number;
  embedding: number[];
}

interface Citation {
  documentId: string;
  filename: string;
  pageNumber: number;
  excerpt: string;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: Citation[];
}

interface DocItem {
  id: string;
  filename: string;
  status: "uploaded" | "processing" | "ready" | "error";
  pageCount?: number;
  chunkCount?: number;
  error?: string;
}

interface ChatItem {
  id: string;
  title: string;
  documentIds: string[];
}

interface LocalDocument extends DocItem {
  storedFilename: string;
  chunks: Chunk[];
}

interface LocalChat extends ChatItem {
  updatedAt: number;
  messages: Message[];
}

interface Database {
  documents: LocalDocument[];
  chats: LocalChat[];
}

const db: Database = { documents: [], chats: [] };
let saveQueue = Promise.resolve();
let geminiApiKey = process.env.GEMINI_API_KEY ?? "";

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

class RequestError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

async function saveDb() {
  // Windows can briefly lock a file while it is indexed or scanned. Retrying the
  // atomic rename prevents a transient lock from failing a document request.
  const save = saveQueue.catch(() => undefined).then(async () => {
    const temporaryPath = `${DB_PATH}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(db), "utf8");
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await rename(temporaryPath, DB_PATH);
          return;
        } catch (error: unknown) {
          const code = typeof error === "object" && error !== null && "code" in error
            ? String((error as { code?: unknown }).code)
            : undefined;
          if ((code !== "EPERM" && code !== "EBUSY") || attempt === 4) throw error;
          await wait(50 * 2 ** attempt);
        }
      }
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  });
  saveQueue = save;
  await save;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    const buffer = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new RequestError("Request exceeds the 5 MB file limit.", 413);
    parts.push(buffer);
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected an object.");
    return body as Record<string, unknown>;
  } catch {
    throw new RequestError("Request body must be valid JSON.");
  }
}

async function loadLocalApiKey() {
  if (geminiApiKey) return;
  let contents: string;
  try {
    contents = await readFile(ENV_PATH, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*GEMINI_API_KEY\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    geminiApiKey = match[1].replace(/^(['"])(.*)\1$/, "$2");
    return;
  }
}

function ai(): GoogleGenAI {
  if (!geminiApiKey) {
    throw new RequestError("Add your Gemini key to .env.local, then restart the local backend.", 503);
  }
  return new GoogleGenAI({ apiKey: geminiApiKey });
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function chunkText(text: string, size = 1000, overlap = 200): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  const chunks: string[] = [];
  for (let start = 0; start < normalized.length; start += size - overlap) {
    const chunk = normalized.slice(start, start + size).trim();
    if (chunk.length >= 20) chunks.push(chunk);
    if (start + size >= normalized.length) break;
  }
  return chunks;
}

async function callGemini<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof RequestError) throw error;
    const message = error instanceof Error ? error.message : "";
    if (/429|quota|resource.?exhausted/i.test(message)) {
      throw new RequestError("Gemini free-tier quota reached. Try again later.", 429);
    }
    if (/api.?key|unauthenticated|permission.?denied|401|403/i.test(message)) {
      throw new RequestError("Gemini rejected the API key. Check it in .env.local.", 401);
    }
    const safeMessage = message
      .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted]")
      .replace(/([?&]key=)[^&\s]+/gi, "$1[redacted]")
      .slice(0, 300);
    console.error("Gemini API request failed:", safeMessage || "Unknown API error");
    throw new RequestError(
      safeMessage ? `Gemini API error: ${safeMessage}` : "Gemini API request failed. Check your internet connection.",
      502,
    );
  }
}

async function embed(texts: string[], taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY"): Promise<number[][]> {
  const vectors: number[][] = [];
  const client = ai();
  for (let start = 0; start < texts.length; start += 50) {
    const response = await callGemini(() => client.models.embedContent({
      model: EMBED_MODEL,
      contents: texts.slice(start, start + 50),
      config: { taskType, outputDimensionality: 768 },
    }));
    for (const embedding of response.embeddings ?? []) vectors.push(embedding.values ?? []);
  }
  if (vectors.length !== texts.length || vectors.some((v) => !v.length)) {
    throw new RequestError("Gemini returned invalid document embeddings. Retry the upload.", 502);
  }
  return vectors;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}

function findDocument(id: string): LocalDocument {
  const document = db.documents.find((item) => item.id === id);
  if (!document) throw new RequestError("Document not found.", 404);
  return document;
}

async function handle(route: string, body: Record<string, unknown>): Promise<unknown> {
  if (route === "health") {
    return { ok: true, geminiConfigured: Boolean(geminiApiKey) };
  }

  if (route === "upload") {
    const filename = String(body.filename ?? "").replace(/[\\/\0]/g, "_").slice(0, 120);
    const contentBase64 = String(body.contentBase64 ?? "");
    const lower = filename.toLowerCase();
    if (!lower.endsWith(".pdf") && !lower.endsWith(".txt")) throw new RequestError("Only PDF and TXT files are supported.");
    const buffer = Buffer.from(contentBase64, "base64");
    if (!buffer.length) throw new RequestError("File is empty.");
    if (buffer.length > MAX_BYTES) throw new RequestError("File exceeds the 5 MB limit.", 413);
    if (lower.endsWith(".pdf") && buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
      throw new RequestError("Not a valid PDF file.");
    }
    const id = randomUUID();
    const storedFilename = `${id}${lower.endsWith(".pdf") ? ".pdf" : ".txt"}`;
    await writeFile(join(UPLOAD_DIR, storedFilename), buffer);
    db.documents.push({
      id, filename, storedFilename, status: "uploaded", pageCount: 0, chunkCount: 0, chunks: [],
    });
    await saveDb();
    return { documentId: id };
  }

  if (route === "ingest") {
    const id = String(body.documentId ?? "");
    const document = findDocument(id);
    if (document.status === "ready") return { chunkCount: document.chunkCount ?? 0 };
    document.status = "processing";
    document.error = undefined;
    await saveDb();
    try {
      const buffer = await readFile(join(UPLOAD_DIR, document.storedFilename));
      const pages: string[] = [];
      if (document.filename.toLowerCase().endsWith(".pdf")) {
        const pdf = await getDocumentProxy(new Uint8Array(buffer));
        const result = await extractText(pdf, { mergePages: false });
        pages.push(...result.text as string[]);
      } else {
        const content = buffer.toString("utf8");
        for (let start = 0; start < content.length; start += 3000) pages.push(content.slice(start, start + 3000));
      }
      const pieces = pages.flatMap((page, index) =>
        chunkText(page).map((text) => ({ text, pageNumber: index + 1 })),
      );
      if (!pieces.length) throw new RequestError("No extractable text found (scanned PDFs are not supported).");
      const vectors = await embed(pieces.map((piece) => piece.text), "RETRIEVAL_DOCUMENT");
      document.chunks = pieces.map((piece, index) => ({ ...piece, embedding: vectors[index] }));
      document.pageCount = pages.length;
      document.chunkCount = pieces.length;
      document.status = "ready";
      await saveDb();
      return { chunkCount: document.chunkCount };
    } catch (error) {
      document.status = "error";
      document.error = error instanceof Error ? error.message : "Processing failed.";
      await saveDb();
      throw error;
    }
  }

  if (route === "documents") {
    return {
      documents: db.documents.map(({ id, filename, status, pageCount, chunkCount, error }) => ({
        id, filename, status, pageCount, chunkCount, error: error ?? null,
      })),
    };
  }

  if (route === "chats") {
    return {
      chats: [...db.chats]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 30)
        .map(({ id, title, documentIds }) => ({ id, title, documentIds })),
    };
  }

  if (route === "messages") {
    const chat = db.chats.find((item) => item.id === String(body.chatId ?? ""));
    if (!chat) throw new RequestError("Chat not found.", 404);
    return { messages: chat.messages.slice(-200) };
  }

  if (route === "ask") {
    const question = String(body.question ?? "").trim();
    const documentIds = Array.isArray(body.documentIds) ? body.documentIds.map(String) : [];
    if (!question || question.length > 1000) throw new RequestError("Question must be 1-1000 characters.");
    if (!documentIds.length || documentIds.length > 10) throw new RequestError("Select 1-10 documents.");
    const selectedDocuments = documentIds.map(findDocument);
    const notReady = selectedDocuments.find((document) => document.status !== "ready");
    if (notReady) throw new RequestError(`${notReady.filename} is not ready yet.`, 409);

    let chat = body.chatId ? db.chats.find((item) => item.id === String(body.chatId)) : undefined;
    if (body.chatId && !chat) throw new RequestError("Chat not found.", 404);
    if (!chat) {
      chat = {
        id: randomUUID(),
        title: question.slice(0, 60),
        documentIds,
        updatedAt: Date.now(),
        messages: [],
      };
      db.chats.push(chat);
    }

    const [queryVector] = await embed([question], "RETRIEVAL_QUERY");
    const candidates = selectedDocuments.flatMap((document) =>
      document.chunks.map((chunk) => ({
        ...chunk,
        documentId: document.id,
        filename: document.filename,
        score: cosineSimilarity(queryVector, chunk.embedding),
      })),
    );
    const topChunks = candidates.sort((a, b) => b.score - a.score).slice(0, TOP_K);
    const promptContext = topChunks.map((chunk, index) =>
      `[${index + 1}] (file: ${chunk.filename}, page ${chunk.pageNumber})\n${chunk.text}`,
    ).join("\n\n");

    let answer = NOT_FOUND;
    let citations: Citation[] = [];
    if (topChunks.length) {
      const result = await callGemini(() => ai().models.generateContent({
        model: CHAT_MODEL,
        contents:
          `Answer using ONLY the numbered document passages below. Do not use outside knowledge.\n` +
          `If they do not answer the question, set found=false. Otherwise provide a concise answer and list passage numbers actually used in sources.\n\n` +
          `PASSAGES:\n${promptContext}\n\nQUESTION: ${question}`,
        config: {
          temperature: 0.2,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              found: { type: Type.BOOLEAN },
              answer: { type: Type.STRING },
              sources: { type: Type.ARRAY, items: { type: Type.INTEGER } },
            },
            required: ["found", "answer", "sources"],
          },
        },
      }));
      let parsed: { found?: boolean; answer?: string; sources?: number[] };
      try {
        parsed = JSON.parse(result.text ?? "{}") as typeof parsed;
      } catch {
        throw new RequestError("Gemini returned an invalid response. Try again.", 502);
      }
      const used = [...new Set((parsed.sources ?? []).filter(
        (number) => Number.isInteger(number) && number >= 1 && number <= topChunks.length,
      ))];
      if (parsed.found && parsed.answer?.trim() && used.length) {
        answer = parsed.answer.trim();
        citations = used.map((number) => {
          const chunk = topChunks[number - 1];
          return {
            documentId: chunk.documentId,
            filename: chunk.filename,
            pageNumber: chunk.pageNumber,
            excerpt: chunk.text.slice(0, 300),
          };
        });
      }
    }

    const now = Date.now();
    chat.messages.push(
      { id: randomUUID(), role: "user", content: question, citations: [] },
      { id: randomUUID(), role: "assistant", content: answer, citations },
    );
    chat.updatedAt = now;
    await saveDb();
    return { chatId: chat.id, answer, citations };
  }

  if (route === "delete") {
    const document = findDocument(String(body.documentId ?? ""));
    await unlink(join(UPLOAD_DIR, document.storedFilename)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    db.documents = db.documents.filter((item) => item.id !== document.id);
    await saveDb();
    return { ok: true };
  }

  throw new RequestError("Unknown API route.", 404);
}

async function start() {
  await loadLocalApiKey();
  await mkdir(UPLOAD_DIR, { recursive: true });
  try {
    const stored = JSON.parse(await readFile(DB_PATH, "utf8")) as Database;
    db.documents = Array.isArray(stored.documents) ? stored.documents : [];
    db.chats = Array.isArray(stored.chats) ? stored.chats : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await saveDb();
  }

  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) {
      send(res, 403, { error: "Local API only accepts requests from localhost." });
      return;
    }
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== "POST" || !req.url?.startsWith("/api/")) {
      send(res, 404, { error: "Not found." });
      return;
    }
    try {
      const body = await readBody(req);
      const result = await handle(req.url.slice("/api/".length), body);
      send(res, 200, result);
    } catch (error) {
      const status = error instanceof RequestError ? error.status : 500;
      const message = error instanceof Error ? error.message : "Unexpected local server error.";
      if (status === 500) console.error(error);
      send(res, status, { error: message });
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`DocuMind local API listening at http://${HOST}:${PORT}`);
    console.log(`Gemini models: ${CHAT_MODEL}; ${EMBED_MODEL}`);
    if (!geminiApiKey) console.log(`Add GEMINI_API_KEY to ${ENV_PATH} and restart this backend.`);
  });
}

start().catch((error) => {
  console.error("Failed to start the local API:", error);
  process.exitCode = 1;
});
