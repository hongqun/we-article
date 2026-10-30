"use client";

import { useEffect, useRef, type ReactNode } from "react";
import styles from "./workspace.module.css";

// 所有工作区弹窗共用原生焦点管理，关闭后还原到触发按钮。
export default function WorkspaceModal({ label, onClose, children, wide = false }: {
  label: string; onClose: () => void; children: ReactNode; wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;
    dialog?.showModal();
    return () => { dialog?.close(); if (previous instanceof HTMLElement) previous.focus(); };
  }, []);
  return <dialog ref={ref} className={`${styles.dialog} ${wide ? styles.configurationDialog : ""}`} aria-labelledby={label}
    onCancel={event => { event.preventDefault(); onClose(); }}>{children}</dialog>;
}
