import { useEffect, useRef, useState } from "react";
import { BookOpen, Loader2, RefreshCw, Send } from "lucide-react";
import { api } from "./api";
import { Message, SUGGESTIONS } from "./types";

interface Props {
  chatId?: string;
  selected: string[];
  onChatId: (id: string) => void;
  onAsked: () => void;
}

export default function Chat({ chatId, selected, onChatId, onAsked }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const end = useRef<HTMLDivElement>(null);

  const loaded = useRef<string | undefined>();
  useEffect(() => {
    if (chatId && loaded.current === chatId) return; // already loaded by send()
    loaded.current = chatId;
    setMessages([]);
    if (chatId) api.getMessages({ chatId }).then((r) => setMessages(r.messages)).catch((e) => setErr(e.message));
  }, [chatId]);

  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, pending]);

  const send = async (q: string) => {
    if (!q.trim() || !selected.length || pending) return;
    setErr(""); setFailed(null); setPending(q); setText("");
    try {
      const r = await api.ask({ question: q, documentIds: selected, chatId });
      const m = await api.getMessages({ chatId: r.chatId });
      loaded.current = r.chatId;
      setMessages(m.messages);
      if (!chatId) onChatId(r.chatId);
    } catch (e) {
      setErr((e as Error).message); setFailed(q);
    }
    onAsked();
    setPending(null);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {!messages.length && !pending && (
          <div className="mx-auto mt-10 max-w-md text-center">
            <h2 className="text-xl font-semibold">Ask your documents anything</h2>
            <p className="mt-1 text-sm text-slate-500">
              {selected.length ? `${selected.length} document(s) selected.` : "Select a ready document in the sidebar to begin."}
            </p>
            <div className="mt-4 space-y-2">
              {(selected.length ? SUGGESTIONS : []).map((s) => (
                <button key={s} onClick={() => send(s)} className="block w-full rounded-xl border border-slate-200 p-2 text-sm hover:border-indigo-400 dark:border-slate-800">{s}</button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => <Bubble key={m.id} m={m} />)}
        {pending && (
          <>
            {!messages.some((m) => m.content === pending && m.role === "user") && <Bubble m={{ id: "p", role: "user", content: pending, citations: [] }} />}
            <div className="flex items-center gap-2 text-sm text-slate-500"><Loader2 size={16} className="animate-spin" />Searching your documents…</div>
          </>
        )}
        {failed && (
          <div className="flex items-center gap-3 rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950 dark:text-red-300">
            {err}
            <button onClick={() => send(failed)} className="flex items-center gap-1 font-medium"><RefreshCw size={14} />Retry</button>
          </div>
        )}
        <div ref={end} />
      </div>
      <form onSubmit={(e) => { e.preventDefault(); send(text); }} className="flex gap-2 border-t border-slate-200 p-3 dark:border-slate-800">
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} disabled={!selected.length}
          placeholder={selected.length ? "Ask a question…" : "Select a document first"}
          className="flex-1 rounded-xl border border-slate-300 bg-transparent px-4 py-2 outline-none focus:border-indigo-500 dark:border-slate-700" />
        <button disabled={!selected.length || !!pending || !text.trim()} className="rounded-xl bg-indigo-600 px-4 text-white disabled:opacity-50" aria-label="Send"><Send size={18} /></button>
      </form>
    </div>
  );
}

function Bubble({ m }: { m: Message }) {
  const user = m.role === "user";
  return (
    <div className={`flex ${user ? "justify-end" : ""}`}>
      <div className={`max-w-[90%] rounded-2xl px-4 py-3 text-sm sm:max-w-[75%] ${user ? "bg-indigo-600 text-white" : "border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"}`}>
        <p className="whitespace-pre-wrap">{m.content}</p>
        {m.citations?.length > 0 && (
          <div className="mt-3 space-y-2 border-t border-slate-200 pt-2 dark:border-slate-700">
            <div className="flex items-center gap-1 text-xs font-semibold text-slate-500"><BookOpen size={13} />Sources</div>
            {m.citations.map((c, i) => (
              <details key={i} className="rounded-lg bg-slate-50 p-2 text-xs dark:bg-slate-800">
                <summary className="cursor-pointer font-medium">{c.filename} · page {c.pageNumber}</summary>
                <p className="mt-1 italic text-slate-600 dark:text-slate-300">“{c.excerpt}…”</p>
              </details>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
