import { useEffect, useRef, useState } from "react";
import { ArrowUp, BookOpen, FileText, Loader2, RefreshCw, Sparkles, WandSparkles } from "lucide-react";
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
    if (chatId && loaded.current === chatId) return;
    loaded.current = chatId;
    setMessages([]);
    if (chatId) api.getMessages({ chatId }).then((result) => setMessages(result.messages)).catch((error) => setErr(error.message));
  }, [chatId]);

  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, pending]);

  const send = async (question: string) => {
    if (!question.trim() || !selected.length || pending) return;
    setErr("");
    setFailed(null);
    setPending(question);
    setText("");
    try {
      const result = await api.ask({ question, documentIds: selected, chatId });
      const response = await api.getMessages({ chatId: result.chatId });
      loaded.current = result.chatId;
      setMessages(response.messages);
      if (!chatId) onChatId(result.chatId);
    } catch (error) {
      setErr((error as Error).message);
      setFailed(question);
    }
    onAsked();
    setPending(null);
  };

  return (
    <div className="chat-layout">
      <div className="conversation">
        {!messages.length && !pending && (
          <div className="welcome">
            <div className="welcome-icon"><WandSparkles size={21} /></div>
            <span className="eyebrow"><span className="eyebrow-dot" /> YOUR DOCUMENTS, UNDERSTOOD</span>
            <h1>Good questions start<br />with <span>great answers.</span></h1>
            <p className="welcome-copy">Ask anything about your documents. Get clear, grounded answers with sources you can trust.</p>
            <div className="welcome-context">
              <span className="context-icon"><FileText size={15} /></span>
              {selected.length ? <span><b>{selected.length} source{selected.length === 1 ? "" : "s"}</b> ready for your questions</span> : <span>Select a document from your library to get started</span>}
            </div>
            {selected.length > 0 && (
              <div className="suggestion-grid">
                {SUGGESTIONS.map((suggestion, index) => (
                  <button key={suggestion} onClick={() => send(suggestion)} className="suggestion-card">
                    <span className="suggestion-number">0{index + 1}</span><span>{suggestion}</span><ArrowUp size={14} className="suggestion-arrow" />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="message-list">
          {messages.map((message) => <Bubble key={message.id} message={message} />)}
          {pending && (
            <>
              {!messages.some((message) => message.content === pending && message.role === "user") && <Bubble message={{ id: "pending", role: "user", content: pending, citations: [] }} />}
              <div className="thinking"><span className="thinking-mark"><Sparkles size={15} /></span><span>Reading your sources and preparing an answer</span><Loader2 size={14} className="spin" /></div>
            </>
          )}
          {failed && <div className="retry-card"><span>{err}</span><button onClick={() => send(failed)}><RefreshCw size={13} /> Try again</button></div>}
        </div>
        <div ref={end} />
      </div>

      <div className="composer-wrap">
        <form onSubmit={(event) => { event.preventDefault(); send(text); }} className="composer">
          <textarea value={text} onChange={(event) => setText(event.target.value)} maxLength={1000} disabled={!selected.length || !!pending}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(text); } }}
            placeholder={selected.length ? "Ask a question about your documents…" : "Select a document to start asking questions"} rows={1} />
          <div className="composer-bottom">
            <span className="composer-hint"><Sparkles size={13} /> AI answers are grounded in your sources</span>
            <span className="composer-controls"><span className="key-hint">↵ to send</span>
              <button disabled={!selected.length || !!pending || !text.trim()} className="send-button" aria-label="Send message"><ArrowUp size={17} /></button>
            </span>
          </div>
        </form>
        <p className="disclaimer">Review AI-generated answers against the cited source material.</p>
      </div>
    </div>
  );
}

function Bubble({ message }: { message: Message }) {
  const user = message.role === "user";
  return (
    <div className={`message ${user ? "message-user" : "message-assistant"}`}>
      {!user && <span className="assistant-mark"><Sparkles size={14} /></span>}
      <div className={`message-body ${user ? "user-bubble" : "assistant-bubble"}`}>
        <p className="message-content">{message.content}</p>
        {!user && message.citations?.length > 0 && (
          <div className="sources">
            <span className="sources-heading"><BookOpen size={13} /> SOURCES</span>
            <div className="source-list">
              {message.citations.map((citation, index) => (
                <details key={index} className="source-card">
                  <summary><FileText size={13} /><span>{citation.filename}</span><span className="source-page">Page {citation.pageNumber}</span></summary>
                  <p>“{citation.excerpt}…”</p>
                </details>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
