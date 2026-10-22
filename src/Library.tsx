import { useRef, useState } from "react";
import { AlertCircle, Check, FileText, FileUp, Loader2, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { api } from "./api";
import { DocItem, SAMPLE_TEXT } from "./types";

const MAX = 5 * 1024 * 1024;

interface Props {
  docs: DocItem[];
  selected: string[];
  onToggle: (id: string) => void;
  onChanged: () => void;
}

export default function Library({ docs, selected, onToggle, onChanged }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<Record<string, true>>({});
  const [err, setErr] = useState("");
  const [drag, setDrag] = useState(false);

  const dropKey = (key: string) =>
    setProgress((previous) => { const next = { ...previous }; delete next[key]; return next; });

  const upload = async (file: File) => {
    setErr("");
    const lower = file.name.toLowerCase();
    if (!(lower.endsWith(".pdf") || lower.endsWith(".txt"))) return setErr("Choose a PDF or TXT file.");
    if (file.size > MAX) return setErr("File exceeds the 5 MB limit.");
    if (!file.size) return setErr("This file is empty.");
    const key = `${Date.now()}-${file.name}`;
    setProgress((previous) => ({ ...previous, [key]: true }));
    try {
      const contentBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
        reader.onerror = () => reject(new Error("Could not read the selected file."));
        reader.readAsDataURL(file);
      });
      const { documentId } = await api.upload({ filename: file.name, contentBase64 });
      dropKey(key);
      onChanged();
      api.ingest({ documentId }).catch((error) => setErr(error.message)).finally(onChanged);
    } catch (error) {
      dropKey(key);
      setErr((error as Error).message);
    }
  };

  const retry = (id: string) => {
    onChanged();
    api.ingest({ documentId: id }).catch((error) => setErr(error.message)).finally(onChanged);
  };
  const del = async (id: string) => {
    if (!confirm("Delete this document and all its data?")) return;
    try { await api.remove({ documentId: id }); onChanged(); }
    catch (error) { setErr((error as Error).message); }
  };

  return (
    <div className="library">
      <div
        onDragOver={(event) => { event.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(event) => { event.preventDefault(); setDrag(false); Array.from(event.dataTransfer.files).forEach(upload); }}
        onClick={() => input.current?.click()}
        className={`upload-zone ${drag ? "upload-zone-active" : ""}`}
      >
        <span className="upload-icon"><FileUp size={19} /></span>
        <span className="upload-title">Add documents</span>
        <span className="upload-caption">Drop files or <b>browse</b></span>
        <span className="upload-meta">PDF, TXT · up to 5 MB</span>
        <input ref={input} type="file" multiple accept=".pdf,.txt" hidden
          onChange={(event) => { Array.from(event.target.files ?? []).forEach(upload); event.target.value = ""; }} />
      </div>

      <button onClick={() => upload(new File([SAMPLE_TEXT], "Sample-Employee-Handbook.txt", { type: "text/plain" }))}
        className="sample-button"><Sparkles size={14} /> Try a sample</button>

      {err && <p className="library-error"><AlertCircle size={13} />{err}</p>}
      {Object.keys(progress).map((key) => (
        <div key={key} className="upload-progress"><Loader2 size={14} className="spin" /><span>Uploading {key.slice(key.indexOf("-") + 1)}…</span></div>
      ))}
      {docs.length === 0 && !Object.keys(progress).length && <p className="library-empty">No documents yet. Add one to get started.</p>}

      <ul className="document-list">
        {docs.map((doc) => (
          <li key={doc.id} className={`document-row ${selected.includes(doc.id) ? "document-row-selected" : ""}`}>
            <button className="document-select" disabled={doc.status !== "ready"} onClick={() => onToggle(doc.id)} title={doc.status === "ready" ? "Use as a source" : "Document is not ready"}>
              <span className={`document-checkbox ${selected.includes(doc.id) ? "checkbox-checked" : ""}`}>{selected.includes(doc.id) && <Check size={12} />}</span>
              <span className={`file-icon ${doc.filename.toLowerCase().endsWith(".pdf") ? "pdf-icon" : "txt-icon"}`}><FileText size={15} /></span>
              <span className="document-copy"><span className="document-name" title={doc.filename}>{doc.filename}</span>
                <span className="document-status">
                  {doc.status === "ready" && <>{doc.pageCount} pages · Ready</>}
                  {(doc.status === "processing" || doc.status === "uploaded") && <><Loader2 size={11} className="spin" /> Indexing…</>}
                  {doc.status === "error" && <span className="document-error">{doc.error ?? "Failed"} <button onClick={(event) => { event.stopPropagation(); retry(doc.id); }} aria-label="Retry indexing"><RefreshCw size={11} /></button></span>}
                </span>
              </span>
            </button>
            <button onClick={() => del(doc.id)} aria-label={`Delete ${doc.filename}`} className="delete-document"><Trash2 size={14} /></button>
          </li>
        ))}
      </ul>
    </div>
  );
}
