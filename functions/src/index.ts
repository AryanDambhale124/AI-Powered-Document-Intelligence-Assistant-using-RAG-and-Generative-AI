import { onCall, HttpsError, CallableRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { GoogleGenAI, Type } from "@google/genai";
import { extractText, getDocumentProxy } from "unpdf";

initializeApp();
const db = getFirestore();
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");

const EMBED_MODEL = "gemini-embedding-001";
const GEN_MODEL = "gemini-2.5-flash";
const DIM = 768;
const MAX_BYTES = 5 * 1024 * 1024; // callable request limit is 10 MB; base64 adds ~33%
const MAX_DOCS = 10; // per session
const DAILY_QUESTIONS = 60; // per session
const DAILY_UPLOADS = 20; // per session
const TOP_K = 8;
const NOT_FOUND = "I couldn't find this information in your uploaded documents.";
const base = { secrets: [GEMINI_API_KEY], region: "us-central1", timeoutSeconds: 300, memory: "1GiB" as const };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * No-login access control: the browser holds a random UUID (a private bearer secret kept in
 * localStorage). Every record is owned by that session, and every function checks it.
 * Unguessable (122 bits) but anyone who has the ID can access that session's data.
 */
const owner = (req: CallableRequest): string => {
  const sid = String(req.data?.sessionId ?? "");
  if (!UUID_RE.test(sid)) throw new HttpsError("invalid-argument", "Missing or invalid session.");
  return `demo_${sid.toLowerCase()}`;
};

async function consume(ownerId: string, field: "q" | "u", limit: number) {
  const ref = db.collection("sessions").doc(ownerId);
  const day = new Date().toISOString().slice(0, 10);
  await db.runTransaction(async (t) => {
    const s = await t.get(ref);
    const d = s.exists && s.data()!.day === day ? s.data()! : { day, q: 0, u: 0 };
    if ((d[field] ?? 0) >= limit) throw new HttpsError("resource-exhausted", "Daily demo limit reached. Try again tomorrow.");
    t.set(ref, { ...d, [field]: (d[field] ?? 0) + 1 });
  });
}

const ai = () => new GoogleGenAI({ apiKey: GEMINI_API_KEY.value() });

function mapGeminiError(e: unknown): never {
  if (e instanceof HttpsError) throw e;
  const msg = String((e as Error)?.message ?? e);
  if (/429|quota|RESOURCE_EXHAUSTED/i.test(msg))
    throw new HttpsError("resource-exhausted", "Gemini quota reached. Please retry shortly.");
  console.error(e);
  throw new HttpsError("internal", "Processing failed. Please retry.");
}

async function embed(texts: string[], taskType: string): Promise<number[][]> {
  const client = ai();
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 50) {
    const r = await client.models.embedContent({
      model: EMBED_MODEL,
      contents: texts.slice(i, i + 50),
      config: { taskType, outputDimensionality: DIM },
    });
    for (const e of r.embeddings ?? []) out.push(e.values ?? []);
  }
  if (out.length !== texts.length) throw new Error("Embedding count mismatch");
  return out;
}

function chunkText(text: string, size = 1000, overlap = 200): string[] {
  const t = text.replace(/\s+/g, " ").trim();
  const res: string[] = [];
  for (let s = 0; s < t.length; s += size - overlap) {
    const c = t.slice(s, s + size).trim();
    if (c.length >= 20) res.push(c);
    if (s + size >= t.length) break;
  }
  return res;
}

/** Public status check (also reports whether the Gemini secret is configured). */
export const health = onCall(base, async () => {
  let geminiConfigured = false;
  try { geminiConfigured = GEMINI_API_KEY.value().length > 10; } catch { /* unset */ }
  return { ok: true, geminiConfigured, embedModel: EMBED_MODEL, genModel: GEN_MODEL };
});

/** Validates and stores an uploaded file in Cloud Storage + creates the document record. */
export const uploadDocument = onCall({ ...base, secrets: [] }, async (req) => {
  const ownerId = owner(req);
  const filename = String(req.data?.filename ?? "").replace(/[\\/\0]/g, "_").slice(0, 120);
  const b64 = String(req.data?.contentBase64 ?? "");
  const lower = filename.toLowerCase();
  if (!lower.endsWith(".pdf") && !lower.endsWith(".txt")) throw new HttpsError("invalid-argument", "Only PDF and TXT are supported.");
  const buf = Buffer.from(b64, "base64");
  if (!buf.length) throw new HttpsError("invalid-argument", "File is empty.");
  if (buf.length > MAX_BYTES) throw new HttpsError("invalid-argument", "File exceeds the 5 MB demo limit.");
  if (lower.endsWith(".pdf") && buf.subarray(0, 5).toString("latin1") !== "%PDF-")
    throw new HttpsError("invalid-argument", "Not a valid PDF file.");

  const count = (await db.collection("documents").where("ownerId", "==", ownerId).count().get()).data().count;
  if (count >= MAX_DOCS) throw new HttpsError("resource-exhausted", `Demo limit: ${MAX_DOCS} documents. Delete one first.`);
  await consume(ownerId, "u", DAILY_UPLOADS);

  const ref = db.collection("documents").doc();
  const storagePath = `demo/${ownerId}/${ref.id}/${filename.replace(/[^\w.-]/g, "_")}`;
  await getStorage().bucket().file(storagePath).save(buf, { contentType: lower.endsWith(".pdf") ? "application/pdf" : "text/plain" });
  await ref.set({
    ownerId, filename, storagePath, status: "uploaded", pageCount: 0, chunkCount: 0,
    size: buf.length, createdAt: FieldValue.serverTimestamp(),
  });
  return { documentId: ref.id };
});

/** Parses a stored file, chunks it, embeds chunks, stores them with vectors. */
export const ingestDocument = onCall(base, async (req) => {
  const ownerId = owner(req);
  const documentId = String(req.data?.documentId ?? "");
  if (!documentId) throw new HttpsError("invalid-argument", "documentId required.");

  const ref = db.collection("documents").doc(documentId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()!.ownerId !== ownerId) throw new HttpsError("permission-denied", "Document not accessible.");
  const d = snap.data()!;
  if (d.status === "ready" || d.status === "processing") return { chunkCount: d.chunkCount ?? 0 };

  try {
    await ref.update({ status: "processing", error: FieldValue.delete() });
    const [buf] = await getStorage().bucket().file(d.storagePath).download();

    const name = String(d.filename).toLowerCase();
    let pages: string[];
    if (name.endsWith(".pdf")) {
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      const r = await extractText(pdf, { mergePages: false });
      pages = r.text as string[];
    } else {
      const all = buf.toString("utf8");
      pages = [];
      for (let i = 0; i < all.length; i += 3000) pages.push(all.slice(i, i + 3000)); // virtual "pages"
    }

    const items: { text: string; pageNumber: number }[] = [];
    pages.forEach((p, i) => chunkText(p).forEach((text) => items.push({ text, pageNumber: i + 1 })));
    if (!items.length) throw new HttpsError("failed-precondition", "No extractable text found (scanned PDF?).");

    const vectors = await embed(items.map((i) => i.text), "RETRIEVAL_DOCUMENT");
    for (let i = 0; i < items.length; i += 400) {
      const batch = db.batch();
      items.slice(i, i + 400).forEach((it, j) => {
        batch.set(ref.collection("chunks").doc(), {
          ownerId, documentId, text: it.text, pageNumber: it.pageNumber,
          chunkIndex: i + j, embedding: FieldValue.vector(vectors[i + j]),
        });
      });
      await batch.commit();
    }
    await ref.update({ status: "ready", pageCount: pages.length, chunkCount: items.length });
    return { chunkCount: items.length };
  } catch (e) {
    const message = e instanceof HttpsError ? e.message : "Processing failed.";
    await ref.update({ status: "error", error: message }).catch(() => {});
    return mapGeminiError(e);
  }
});

export const listDocuments = onCall({ ...base, secrets: [] }, async (req) => {
  const ownerId = owner(req);
  const s = await db.collection("documents").where("ownerId", "==", ownerId).orderBy("createdAt", "desc").limit(50).get();
  return {
    documents: s.docs.map((d) => {
      const x = d.data();
      return { id: d.id, filename: x.filename, status: x.status, pageCount: x.pageCount, chunkCount: x.chunkCount, error: x.error ?? null };
    }),
  };
});

export const listChats = onCall({ ...base, secrets: [] }, async (req) => {
  const ownerId = owner(req);
  const s = await db.collection("chats").where("ownerId", "==", ownerId).orderBy("createdAt", "desc").limit(30).get();
  return { chats: s.docs.map((d) => ({ id: d.id, title: d.data().title, documentIds: d.data().documentIds ?? [] })) };
});

export const getMessages = onCall({ ...base, secrets: [] }, async (req) => {
  const ownerId = owner(req);
  const chatId = String(req.data?.chatId ?? "");
  if (!chatId) throw new HttpsError("invalid-argument", "chatId required.");
  const chat = db.collection("chats").doc(chatId);
  const c = await chat.get();
  if (!c.exists || c.data()!.ownerId !== ownerId) throw new HttpsError("permission-denied", "Chat not accessible.");
  const s = await chat.collection("messages").orderBy("createdAt", "asc").limit(200).get();
  return {
    messages: s.docs.map((m) => {
      const x = m.data();
      return { id: m.id, role: x.role, content: x.content, citations: x.citations ?? [], error: x.error ?? false };
    }),
  };
});

/** RAG: embed query -> vector search (session-scoped) -> grounded Gemini answer + citations. */
export const askQuestion = onCall(base, async (req) => {
  const ownerId = owner(req);
  const question = String(req.data?.question ?? "").trim();
  const documentIds: string[] = Array.isArray(req.data?.documentIds) ? req.data.documentIds.map(String) : [];
  let chatId: string | undefined = req.data?.chatId ? String(req.data.chatId) : undefined;
  if (!question || question.length > 1000) throw new HttpsError("invalid-argument", "Question must be 1-1000 characters.");
  if (!documentIds.length || documentIds.length > 10) throw new HttpsError("invalid-argument", "Select 1-10 documents.");

  const names = new Map<string, string>();
  for (const id of documentIds) {
    const s = await db.collection("documents").doc(id).get();
    if (!s.exists || s.data()!.ownerId !== ownerId) throw new HttpsError("permission-denied", "Document not accessible.");
    if (s.data()!.status !== "ready") throw new HttpsError("failed-precondition", `${s.data()!.filename} is not ready yet.`);
    names.set(id, s.data()!.filename);
  }
  await consume(ownerId, "q", DAILY_QUESTIONS);

  if (chatId) {
    const c = await db.collection("chats").doc(chatId).get();
    if (!c.exists || c.data()!.ownerId !== ownerId) throw new HttpsError("permission-denied", "Chat not accessible.");
  } else {
    const c = await db.collection("chats").add({
      ownerId, documentIds, title: question.slice(0, 60), createdAt: FieldValue.serverTimestamp(),
    });
    chatId = c.id;
  }
  const msgs = db.collection("chats").doc(chatId).collection("messages");
  await msgs.add({ role: "user", content: question, citations: [], createdAt: FieldValue.serverTimestamp() });

  let answer = NOT_FOUND;
  let citations: { documentId: string; filename: string; pageNumber: number; excerpt: string }[] = [];
  try {
    const [qv] = await embed([question], "RETRIEVAL_QUERY");
    const hits = await db.collectionGroup("chunks")
      .where("ownerId", "==", ownerId)
      .where("documentId", "in", documentIds)
      .findNearest({ vectorField: "embedding", queryVector: qv, limit: TOP_K, distanceMeasure: "COSINE" })
      .get();
    const chunks = hits.docs.map((h) => h.data() as { text: string; pageNumber: number; documentId: string });

    if (chunks.length) {
      const context = chunks
        .map((c, i) => `[${i + 1}] (file: ${names.get(c.documentId)}, page ${c.pageNumber})\n${c.text}`)
        .join("\n\n");
      const prompt =
        `You answer questions using ONLY the numbered context passages below. Do not use outside knowledge.\n` +
        `If the passages do not contain the answer, set found=false.\n` +
        `Otherwise set found=true, write a concise answer, and list in "sources" the passage numbers you actually used.\n\n` +
        `CONTEXT:\n${context}\n\nQUESTION: ${question}`;
      const r = await ai().models.generateContent({
        model: GEN_MODEL,
        contents: prompt,
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
      });
      const parsed = JSON.parse(r.text ?? "{}") as { found?: boolean; answer?: string; sources?: number[] };
      const used = [...new Set((parsed.sources ?? []).filter((n) => Number.isInteger(n) && n >= 1 && n <= chunks.length))];
      if (parsed.found && parsed.answer && used.length) {
        answer = parsed.answer;
        // Citations come from real retrieved chunks only, never from model-written text.
        citations = used.map((n) => {
          const c = chunks[n - 1];
          return { documentId: c.documentId, filename: names.get(c.documentId) ?? "", pageNumber: c.pageNumber, excerpt: c.text.slice(0, 300) };
        });
      }
    }
  } catch (e) {
    await msgs.add({ role: "assistant", content: "Something went wrong answering this. Please retry.", citations: [], error: true, createdAt: FieldValue.serverTimestamp() });
    return mapGeminiError(e);
  }

  await msgs.add({ role: "assistant", content: answer, citations, createdAt: FieldValue.serverTimestamp() });
  return { chatId, answer, citations };
});

/** Deletes a document, its chunks and its stored file. */
export const deleteDocument = onCall({ ...base, secrets: [] }, async (req) => {
  const ownerId = owner(req);
  const documentId = String(req.data?.documentId ?? "");
  if (!documentId) throw new HttpsError("invalid-argument", "documentId required.");
  const ref = db.collection("documents").doc(documentId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()!.ownerId !== ownerId) throw new HttpsError("permission-denied", "Document not accessible.");
  await getStorage().bucket().file(snap.data()!.storagePath).delete({ ignoreNotFound: true });
  await db.recursiveDelete(ref); // removes chunks subcollection too
  return { ok: true };
});
