"use client";

import { useEffect, useRef, useState } from "react";

// 删除会影响正文版本和风格证据，必须输入完整确认词才开放最终操作。
export default function DeleteProjectDialog({ project, onClose, onConfirm }: {
  project: { id: string; title: string } | null; onClose: () => void; onConfirm: (id: string) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (project) { setConfirmation(""); dialog.current?.showModal(); } }, [project]);
  async function confirm() {
    if (!project || confirmation !== "删除") return;
    setBusy(true);
    try { await onConfirm(project.id); dialog.current?.close(); onClose(); }
    catch { /* 父页面已展示接口错误；对话框保留，方便用户重试或取消。 */ }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="confirm-dialog" onClose={onClose} aria-labelledby="delete-project-title">
    <h2 id="delete-project-title">删除文章项目</h2>
    <p>将删除“{project?.title}”及其正文、所有版本、成稿和关联学习证据。此操作无法在工作台撤销。</p>
    <label>输入“删除”以确认<input autoFocus value={confirmation} disabled={busy} onChange={event => setConfirmation(event.target.value)} /></label>
    <footer><button type="button" disabled={busy} onClick={() => dialog.current?.close()}>取消</button>
      <button type="button" className="danger" disabled={busy || confirmation !== "删除"} onClick={() => void confirm()}>确认删除</button></footer>
  </dialog>;
}
