import { useCallback, useEffect, useState } from "react";
import { Brain, FileText, Menu, MessageSquarePlus, Moon, ShieldCheck, Sparkles, Sun, X } from "lucide-react";
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
  const [dark, setDark] = useState(() => localStorage.getItem("theme") === "dark");
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
    refreshDocs();
    refreshChats();
    api.health().then((r) => {
      setBanner(r.geminiConfigured ? "" : "Add your Gemini API key to .env.local, then restart the local backend.");
    }).catch((e: Error) => setBanner(e.message));
  }, [refreshDocs, refreshChats]);

  const busy = docs.some((d) => d.status === "uploaded" || d.status === "processing");
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(refreshDocs, 3000);
    return () => clearInterval(timer);
  }, [busy, refreshDocs]);

  useEffect(() => {
    setSelected((current) => current.filter((id) => docs.some((doc) => doc.id === id && doc.status === "ready")));
  }, [docs]);

  const toggle = (id: string) => {
    setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
    setChatId(undefined);
  };
  const openChat = (chat: ChatItem) => {
    setChatId(chat.id);
    setSelected(chat.documentIds.filter((id) => docs.some((doc) => doc.id === id && doc.status === "ready")));
    setOpen(false);
  };
  const newChat = () => {
    setChatId(undefined);
    setOpen(false);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <button className="icon-button mobile-menu" onClick={() => setOpen(!open)} aria-label="Toggle navigation">
            {open ? <X size={19} /> : <Menu size={19} />}
          </button>
          <span className="brand-mark"><Brain size={19} strokeWidth={2.2} /></span>
          <span className="brand-name">DocuMind<span className="brand-ai"> AI</span></span>
          <span className="brand-divider" />
          <span className="brand-workspace">Workspace</span>
        </div>
        <div className="topbar-actions">
          <span className="privacy-badge"><ShieldCheck size={14} /> Private workspace</span>
          <button onClick={() => setDark(!dark)} aria-label="Toggle theme" className="icon-button theme-button">
            {dark ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <span className="avatar">D</span>
        </div>
      </header>

      {banner && <div className="status-banner"><Sparkles size={15} />{banner}</div>}

      <div className="workspace">
        <aside className={`sidebar ${open ? "sidebar-open" : ""}`}>
          <div className="sidebar-scroll">
            <div className="nav-section-label">YOUR WORKSPACE</div>
            <div className="nav-current"><span className="nav-current-icon"><Brain size={16} /></span>Document assistant</div>

            <div className="side-heading">
              <span>YOUR LIBRARY</span>
              <span className="count-pill">{docs.length}</span>
            </div>
            <Library docs={docs} selected={selected} onToggle={toggle} onChanged={refreshDocs} />

            <div className="side-heading chat-heading">
              <span>RECENT CHATS</span>
              <button onClick={newChat} aria-label="Start a new chat" className="small-icon-button"><MessageSquarePlus size={15} /></button>
            </div>
            {chats.length ? (
              <ul className="chat-history">
                {chats.map((chat) => (
                  <li key={chat.id}>
                    <button onClick={() => openChat(chat)} className={`history-item ${chat.id === chatId ? "history-active" : ""}`}>
                      <MessageSquarePlus size={15} /><span>{chat.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty-history">Your conversations will appear here.</p>
            )}
          </div>
          <div className="sidebar-footer">
            <span className="online-dot" />
            <span>AI ready</span>
            <span className="footer-separator">·</span>
            <span>Gemini</span>
          </div>
        </aside>

        {open && <button className="sidebar-backdrop" aria-label="Close navigation" onClick={() => setOpen(false)} />}

        <main className="main-panel">
          <div className="content-toolbar">
            <div className="breadcrumb"><FileText size={15} /><span>Document assistant</span><span className="breadcrumb-separator">/</span><span className="breadcrumb-muted">{chatId ? "Conversation" : "New conversation"}</span></div>
            <span className="selection-indicator">{selected.length ? `${selected.length} source${selected.length === 1 ? "" : "s"} selected` : "No sources selected"}</span>
          </div>
          <Chat chatId={chatId} selected={selected} onChatId={setChatId} onAsked={refreshChats} />
        </main>
      </div>
    </div>
  );
}
