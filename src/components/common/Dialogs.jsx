import React, { useEffect, useRef, useState } from 'react';
import styles from './Dialogs.module.css';

// The app's own messages instead of the browser's alert/confirm/prompt
// boxes, which ignore the design and block the page:
// - notify(message, kind?): a toast in the corner that fades after a few
//   seconds. kind is 'success' | 'error' | 'warning' | 'info'; without it
//   the wording decides (an error message reads like one).
// - confirmDialog(message, options?): resolves true or false.
// - promptDialog(message, defaultValue?, options?): resolves the text, or
//   null when cancelled.
// - choiceDialog(message, { title, choices }): more than one way forward
//   (e.g. Save / Don't save); resolves the chosen value, or null when
//   cancelled. choices: [{ value, label, kind: 'primary' | 'danger' }].
// They work from anywhere (no hook needed); <DialogHost /> in App renders
// them. Dialogs queue: a second one opens when the first is answered.

let toasts = [];
let dialogs = [];
let nextId = 1;
const listeners = new Set();
const emit = () => listeners.forEach(fn => fn({ toasts, dialog: dialogs[0] || null }));

function guessKind(message) {
  const text = String(message);
  if (/\b(error|failed|fail|invalid|cannot|can't|could not|unable|timed out|not configured)\b/i.test(text)) return 'error';
  if (/\b(success|successfully|saved|updated|deleted|created|posted|queued|started|initiated|rebuilt|added)\b/i.test(text)) return 'success';
  if (/\b(required|enter|choose|select|must|please)\b/i.test(text)) return 'warning';
  return 'info';
}

export function notify(message, kind) {
  const toast = { id: nextId++, message: String(message ?? ''), kind: kind || guessKind(message) };
  toasts = [...toasts, toast].slice(-4);
  emit();
  const ttl = toast.kind === 'error' ? 9000 : toast.kind === 'warning' ? 6000 : 4500;
  setTimeout(() => dismissToast(toast.id), ttl);
}

function dismissToast(id) {
  toasts = toasts.filter(t => t.id !== id);
  emit();
}

function openDialog(dialog) {
  return new Promise(resolve => {
    dialogs = [...dialogs, { ...dialog, id: nextId++, resolve }];
    emit();
  });
}

function closeDialog(value) {
  const [current, ...rest] = dialogs;
  if (!current) return;
  dialogs = rest;
  emit();
  current.resolve(value);
}

// A message that deletes something gets a red button labelled Delete.
export function confirmDialog(message, { title, confirmLabel, danger } = {}) {
  const destructive = danger ?? /\b(delete|remove|danger)\b/i.test(String(message));
  return openDialog({
    type: 'confirm',
    message: String(message),
    title: title || (destructive ? 'Are you sure?' : 'Please confirm'),
    confirmLabel: confirmLabel || (destructive ? 'Delete' : 'Continue'),
    danger: destructive,
  });
}

export function promptDialog(message, defaultValue = '', { title, confirmLabel } = {}) {
  return openDialog({
    type: 'prompt',
    message: String(message),
    title: title || 'Enter a value',
    confirmLabel: confirmLabel || 'OK',
    defaultValue: defaultValue == null ? '' : String(defaultValue),
  });
}

export function choiceDialog(message, { title, choices = [], danger = false } = {}) {
  return openDialog({
    type: 'choice',
    message: String(message),
    title: title || 'Please choose',
    choices,
    danger,
  });
}

const ICONS = {
  success: <path fillRule="evenodd" clipRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" />,
  error: <path fillRule="evenodd" clipRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" />,
  warning: <path fillRule="evenodd" clipRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" />,
  info: <path fillRule="evenodd" clipRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" />,
};

function Icon({ kind }) {
  return <svg className={styles.icon} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">{ICONS[kind] || ICONS.info}</svg>;
}

function Dialog({ dialog }) {
  const [value, setValue] = useState(dialog.defaultValue || '');
  const confirmRef = useRef(null);
  const inputRef = useRef(null);

  const cancelValue = dialog.type === 'confirm' ? false : null;
  // Enter picks the main choice of a choice dialog.
  const mainChoice = dialog.type === 'choice'
    ? (dialog.choices.find(c => c.kind === 'primary') || dialog.choices[dialog.choices.length - 1])
    : null;

  useEffect(() => {
    (dialog.type === 'prompt' ? inputRef.current : confirmRef.current)?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeDialog(dialog.type === 'confirm' ? false : null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog]);

  const submit = (e) => {
    e?.preventDefault();
    if (dialog.type === 'choice') closeDialog(mainChoice ? mainChoice.value : null);
    else closeDialog(dialog.type === 'prompt' ? value : true);
  };
  const cancel = () => closeDialog(cancelValue);

  return (
    <div className={styles.overlay} onMouseDown={e => { if (e.target === e.currentTarget) cancel(); }}>
      <form className={styles.dialog} role="alertdialog" aria-modal="true" aria-labelledby="app-dialog-title" onSubmit={submit}>
        <div className={`${styles.dialogIcon} ${dialog.danger ? styles.error : styles.info}`}>
          <Icon kind={dialog.danger ? 'warning' : 'info'} />
        </div>
        <h2 id="app-dialog-title" className={styles.dialogTitle}>{dialog.title}</h2>
        <p className={styles.dialogMessage}>{dialog.message}</p>
        {dialog.type === 'prompt' && (
          <input
            ref={inputRef}
            className={styles.input}
            value={value}
            onChange={e => setValue(e.target.value)}
            inputMode="decimal"
          />
        )}
        <div className={styles.actions}>
          <button type="button" className={styles.secondary} onClick={cancel}>Cancel</button>
          {dialog.type === 'choice' ? dialog.choices.map(choice => (
            <button
              key={choice.value}
              ref={choice === mainChoice ? confirmRef : undefined}
              type="button"
              className={choice.kind === 'danger' ? styles.dangerOutline : choice.kind === 'primary' ? styles.primary : styles.secondary}
              onClick={() => closeDialog(choice.value)}
            >
              {choice.label}
            </button>
          )) : (
            <button
              ref={confirmRef}
              type="submit"
              className={`${styles.primary} ${dialog.danger ? styles.dangerButton : ''}`}
            >
              {dialog.confirmLabel}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

export function DialogHost() {
  const [state, setState] = useState({ toasts, dialog: dialogs[0] || null });
  useEffect(() => {
    listeners.add(setState);
    return () => listeners.delete(setState);
  }, []);

  return (
    <>
      <div className={styles.toasts} aria-live="polite">
        {state.toasts.map(t => (
          <div key={t.id} className={`${styles.toast} ${styles[t.kind]}`} role={t.kind === 'error' ? 'alert' : 'status'}>
            <Icon kind={t.kind} />
            <span className={styles.toastMessage}>{t.message}</span>
            <button type="button" className={styles.toastClose} onClick={() => dismissToast(t.id)} aria-label="Dismiss">×</button>
          </div>
        ))}
      </div>
      {state.dialog && <Dialog key={state.dialog.id} dialog={state.dialog} />}
    </>
  );
}
