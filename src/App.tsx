import { useCallback, useEffect, useState } from "react";
import { Brain, Menu, MessageSquarePlus, Moon, Sun, X } from "lucide-react";
import { api } from "./api";
import Library from "./Library";
import Chat from "./Chat";
import { ChatItem, DocItem } from "./types";

export default function App() {
  const [docs, setDocs] = useState<DocItem[]>([]);
  const [chats, setChats] = useState<ChatItem[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [chatId, setChatId] = useState<string | undefined>();
  const [open, setOpen] = useState(false);
  const [dark, setDark] = useState(() => localStorage.getItem("theme") !== "light");
  const [banner, setBanner] = useState("");

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("theme", dark ? "dark" : "light");
  }, [dark]);

  const refreshDocs = useCallback(() => {
    api.listDocuments().then((r) => setDocs(r.documents)).catch(console.error);
  }, []);
  const refreshChats = useCallback(() => {
    api.listChats().then((r) => setChats(r.chats)).catch(console.error);
  }, []);

  useEffect(() => {
    refreshDocs(); refreshChats();
    api.health().then((r) => {
      setBanner(r.geminiConfigured ? "" : "Add your Gemini API key to .env.local, then restart the local backend.");
    }).catch((e: Error) => setBanner(e.message));
  }, [refreshDocs, refreshChats]);

  // Poll while any document is still being processed.
  const busy = docs.some((d) => d.status === "uploaded" || d.status === "processing");
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(refreshDocs, 3000);
    return () => clearInterval(t);
  }, [busy, refreshDocs]);

  // Drop selections for documents that were deleted or are no longer ready.
  useEffect(() => {
    setSelected((s) => s.filter((id) => docs.some((d) => d.id === id && d.status === "ready")));
  }, [docs]);

  const toggle = (id: string) => { setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id])); setChatId(undefined); };
  const openChat = (c: ChatItem) => { setChatId(c.id); setSelected(c.documentIds.filter((id) => docs.some((d) => d.id === id && d.status === "ready"))); setOpen(false); };

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-2 border-b border-slate-200 bg-white/80 px-4 py-2 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80">
        <button className="md:hidden" onClick={() => setOpen(!open)} aria-label="Menu">{open ? <X /> : <Menu />}</button>
        <span className="rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 p-1.5 text-white"><Brain size={18} /></span>
        <h1 className="font-bold">DocuMind AI</h1>
        <span className="hidden rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800 sm:inline">Local AI</span>
        <div className="flex-1" />
        <button onClick={() => setDark(!dark)} aria-label="Toggle theme" className="rounded-lg p-2 hover:bg-slate-100 dark:hover:bg-slate-800">{dark ? <Sun size={18} /> : <Moon size={18} />}</button>
      </header>
      {banner && <div className="bg-amber-100 px-4 py-1.5 text-center text-xs text-amber-800">{banner}</div>}
      <div className="relative flex min-h-0 flex-1">
        <aside className={`${open ? "absolute inset-0 z-10" : "hidden"} w-full overflow-y-auto border-r border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900 md:static md:block md:w-80 md:shrink-0`}>
          <Library docs={docs} selected={selected} onToggle={toggle} onChanged={refreshDocs} />
          <div className="mt-6 flex items-center justify-between text-xs font-semibold uppercase text-slate-500">
            Chats
            <button onClick={() => { setChatId(undefined); setOpen(false); }} className="flex items-center gap-1 normal-case text-indigo-600"><MessageSquarePlus size={14} />New</button>
          </div>
          <ul className="mt-2 space-y-1">
            {chats.map((c) => (
              <li key={c.id}><button onClick={() => openChat(c)} className={`w-full truncate rounded-lg px-2 py-1.5 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800 ${c.id === chatId ? "bg-slate-100 dark:bg-slate-800" : ""}`}>{c.title}</button></li>
            ))}
            {!chats.length && <li className="text-xs text-slate-500">No chats yet.</li>}
          </ul>
        </aside>
        <main className="min-w-0 flex-1 bg-gradient-to-b from-white to-slate-50 dark:from-slate-950 dark:to-slate-900">
          <Chat chatId={chatId} selected={selected} onChatId={setChatId} onAsked={refreshChats} />
        </main>
      </div>
    </div>
  );
}
