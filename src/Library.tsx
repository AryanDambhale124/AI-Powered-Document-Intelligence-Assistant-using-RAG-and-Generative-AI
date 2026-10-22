import { useRef, useState } from "react";
import { AlertCircle, CheckCircle2, FileText, Loader2, RefreshCw, Sparkles, Trash2, UploadCloud } from "lucide-react";
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
    setProgress((p) => { const n = { ...p }; delete n[key]; return n; });

  const upload = async (file: File) => {
    setErr("");
    const lower = file.name.toLowerCase();
    if (!(lower.endsWith(".pdf") || lower.endsWith(".txt"))) return setErr("Only PDF and TXT files are supported.");
    if (file.size > MAX) return setErr("File exceeds the 5 MB demo limit.");
    if (file.size === 0) return setErr("File is empty.");
    const key = `${Date.now()}-${file.name}`;
    setProgress((p) => ({ ...p, [key]: true }));
    try {
      const contentBase64 = await new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result).split(",")[1] ?? "");
        r.onerror = () => rej(new Error("Could not read file."));
        r.readAsDataURL(file);
      });
      const { documentId } = await api.upload({ filename: file.name, contentBase64 });
      dropKey(key);
      onChanged();
      api.ingest({ documentId }).catch((e) => setErr(e.message)).finally(onChanged); // status shows via polling
    } catch (e) {
      dropKey(key);
      setErr((e as Error).message);
    }
  };

  const retry = (id: string) => { onChanged(); api.ingest({ documentId: id }).catch((e) => setErr(e.message)).finally(onChanged); };
  const del = async (id: string) => {
    if (!confirm("Delete this document and all its data?")) return;
    try { await api.remove({ documentId: id }); onChanged(); } catch (e) { setErr((e as Error).message); }
  };

  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); Array.from(e.dataTransfer.files).forEach(upload); }}
        onClick={() => input.current?.click()}
        className={`cursor-pointer rounded-xl border-2 border-dashed p-4 text-center text-sm transition ${drag ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-950" : "border-slate-300 hover:border-indigo-400 dark:border-slate-700"}`}
      >
        <UploadCloud className="mx-auto mb-1 text-indigo-500" />
        Drop PDF/TXT here or click (max 5 MB)
        <input ref={input} type="file" multiple accept=".pdf,.txt" hidden
          onChange={(e) => { Array.from(e.target.files ?? []).forEach(upload); e.target.value = ""; }} />
      </div>
      <button
        onClick={() => upload(new File([SAMPLE_TEXT], "Sample-Employee-Handbook.txt", { type: "text/plain" }))}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-indigo-500 to-violet-600 py-2 text-sm font-medium text-white hover:opacity-90"
      >
        <Sparkles size={16} /> Try the sample document
      </button>
      {err && <p className="rounded-lg bg-red-50 p-2 text-xs text-red-600 dark:bg-red-950 dark:text-red-300">{err}</p>}

      {Object.keys(progress).map((k) => (
        <div key={k} className="text-xs">
          <div className="mb-1 truncate">Uploading {k.slice(k.indexOf("-") + 1)}…</div>
          <div className="h-1.5 overflow-hidden rounded bg-slate-200 dark:bg-slate-800"><div className="h-full w-1/3 animate-pulse rounded bg-indigo-500" /></div>
        </div>
      ))}

      {docs.length === 0 && !Object.keys(progress).length && (
        <p className="py-4 text-center text-sm text-slate-500">No documents yet. Upload one or try the sample.</p>
      )}
      <ul className="space-y-2">
        {docs.map((d) => (
          <li key={d.id} className={`rounded-xl border p-2 text-sm ${selected.includes(d.id) ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-950/40" : "border-slate-200 dark:border-slate-800"}`}>
            <div className="flex items-center gap-2">
              <input type="checkbox" disabled={d.status !== "ready"} checked={selected.includes(d.id)} onChange={() => onToggle(d.id)} />
              <FileText size={16} className="shrink-0 text-slate-400" />
              <span className="flex-1 truncate" title={d.filename}>{d.filename}</span>
              <button onClick={() => del(d.id)} aria-label="Delete" className="text-slate-400 hover:text-red-500"><Trash2 size={15} /></button>
            </div>
            <div className="ml-7 mt-1 flex items-center gap-2 text-xs text-slate-500">
              {d.status === "ready" && <><CheckCircle2 size={13} className="text-emerald-500" />{d.pageCount} pages · {d.chunkCount} chunks</>}
              {(d.status === "processing" || d.status === "uploaded") && <><Loader2 size={13} className="animate-spin" />Processing & embedding…</>}
              {d.status === "error" && (
                <><AlertCircle size={13} className="text-red-500" /><span className="truncate text-red-500">{d.error ?? "Failed"}</span>
                  <button onClick={() => retry(d.id)} className="flex items-center gap-1 text-indigo-600"><RefreshCw size={12} />Retry</button></>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
