import React, { useState, useEffect, useRef, useLayoutEffect, useContext } from 'react';
import useDraggableWindow from '../../utils/useDraggableWindow';
import useScrollLock from '../../utils/useScrollLock';
import ReactQuill from 'react-quill';
import { useDropzone } from 'react-dropzone';
import 'react-quill/dist/quill.snow.css';
import styles from './DayNote.module.css';
import { TradeContext } from '../../context/TradeContext';
import { formatMoney } from '../../utils/formatMoney';
import { sumByCurrency, toTotalsList } from '../../utils/currencyTotals';
import IconButton from '../common/IconButton';
import { notify, confirmDialog, choiceDialog } from '../common/Dialogs';

const getCurrentDate = () => {
  const now = new Date();
  const pad = n => n.toString().padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

const formatDateForInput = (date) => {
  if (!(date instanceof Date) || isNaN(date)) return getCurrentDate();
  const pad = n => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const moodSvgs = [
  // Sad
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM7 9a1 1 0 100-2 1 1 0 000 2zm7-1a1 1 0 11-2 0 1 1 0 012 0zm-7.536 5.879a1 1 0 001.415 0 3 3 0 014.242 0 1 1 0 001.415-1.415 5 5 0 00-7.072 0 1 1 0 000 1.415z" clipRule="evenodd"/></svg>,
  // Neutral
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M 10 18 a 8 8 0 1 0 0 -16 a 8 8 0 0 0 0 16 z M 7 9 a 1 1 0 1 0 0 -2 a 1 1 0 0 0 0 2 z m 7 -1 a 1 1 0 1 1 -2 0 a 1 1 0 0 1 2 0 z m -0.464 5.535 q 0.464 -1.535 -1.415 -1.414 l -4.242 0 q -1.879 -0.121 -1.415 1.414 q 3.536 0.465 7.072 0 z" clipRule="evenodd"/></svg>,
  // Happy
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM7 9a1 1 0 100-2 1 1 0 000 2zm7-1a1 1 0 11-2 0 1 1 0 012 0zm-.464 5.535a1 1 0 10-1.415-1.414 3 3 0 01-4.242 0 1 1 0 00-1.415 1.414 5 5 0 007.072 0z" clipRule="evenodd"/></svg>,
];

const mktConditionSvgs = [
  // Trending down
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M12 13a1 1 0 100 2h5a1 1 0 001-1V9a1 1 0 10-2 0v2.586l-4.293-4.293a1 1 0 00-1.414 0L8 9.586 3.707 5.293a1 1 0 00-1.414 1.414l5 5a1 1 0 001.414 0L11 9.414 14.586 13H12z" clipRule="evenodd"/></svg>,
  // Sideways
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M8 5a1 1 0 100 2h5.586l-1.293 1.293a1 1 0 001.414 1.414l3-3a1 1 0 000-1.414l-3-3a1 1 0 10-1.414 1.414L13.586 5H8zM12 15a1 1 0 100-2H6.414l1.293-1.293a1 1 0 10-1.414-1.414l-3 3a1 1 0 000 1.414l3 3a1 1 0 001.414-1.414L6.414 15H12z" clipRule="evenodd"/></svg>,
  // Trending up
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M12 7a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0V8.414l-4.293 4.293a1 1 0 01-1.414 0L8 10.414l-4.293 4.293a1 1 0 01-1.414-1.414l5-5a1 1 0 011.414 0L11 10.586 14.586 7H12z" clipRule="evenodd"/></svg>,
];

const mktVolSvgs = [
  // Low
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M 8 11 a 1 1 0 0 1 1 -1 h 2 a 1 1 0 0 1 1 1 v 5 a 1 1 0 0 1 -1 1 H 9 a 1 1 0 0 1 -1 -1 v -5 z" clipRule="evenodd"/></svg>,
  // Medium
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M 5 11 a 1 1 0 0 1 1 -1 h 2 a 1 1 0 0 1 1 1 v 5 a 1 1 0 0 1 -1 1 H 6 a 1 1 0 0 1 -1 -1 v -5 z M 11 7 a 1 1 0 0 1 1 -1 h 2 a 1 1 0 0 1 1 1 v 9 a 1 1 0 0 1 -1 1 H 12 a 1 1 0 0 1 -1 -1 V 7 z" clipRule="evenodd"/></svg>,
  // High
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M2 11a1 1 0 011-1h2a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5zM8 7a1 1 0 011-1h2a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1V7zM14 4a1 1 0 011-1h2a1 1 0 011 1v12a1 1 0 01-1 1h-2a1 1 0 01-1-1V4z" clipRule="evenodd"/></svg>,
];

function SegmentedRadio({ name, value, onChange, options }) {
  return (
    <div className={styles['radio-btn-group']}>
      {options.map((icon, idx) => (
        <React.Fragment key={idx}>
          <input
            type="radio"
            id={`${name}-${idx}`}
            name={name}
            className="hidden"
            checked={value === idx}
            onChange={() => onChange(idx)}
          />
          <label
            htmlFor={`${name}-${idx}`}
            className={`${styles['radio-btn']}${value === idx ? ' selected' : ''}`}
          >
            <span className="inline-block justify-center align-middle">{icon}</span>
          </label>
        </React.Fragment>
      ))}
    </div>
  );
}

export default function DayNote({ note, onClose }) {
  const { refreshTrades, currentAccountId, scopedTrades: trades } = useContext(TradeContext);
  // A sub-account's note (listed under its parent) saves to its own account.
  const noteAccountId = note?.account_id ?? currentAccountId;
  const [mood, setMood] = useState(note && note.mood !== undefined ? note.mood : 1);
  const [marketCondition, setMarketCondition] = useState(note && note.market_condition !== undefined ? note.market_condition : 1);
  const [marketVolatility, setMarketVolatility] = useState(note && note.market_volume !== undefined ? note.market_volume : 1);
  const [date, setDate] = useState(note ? formatDateForInput(new Date(note.date)) : getCurrentDate());

  // The trades closed on this note's day (local calendar day), shown at the
  // top so the day's result is in view while writing about it.
  const dayTrades = (Array.isArray(trades) ? trades : []).filter(t => {
    if (t.status === 'OPEN' || !t.lastActionDate || typeof t.lastActionDate.toFormat !== 'function') return false;
    return t.lastActionDate.toFormat('yyyy-MM-dd') === date;
  });
  const dayWins = dayTrades.filter(t => t.status === 'WIN').length;
  const dayLosses = dayTrades.filter(t => t.status === 'LOSS').length;
  const dayPnl = toTotalsList(sumByCurrency(dayTrades, t => t.return || 0));
  const daySymbols = [...new Set(dayTrades.map(t => t.symbol))];
  const [summary, setSummary] = useState(note ? note.summary || '' : '');
  const [notes, setNotes] = useState(note ? note.notes_html || '' : '');
  // The notes as the editor first shows them. Quill rewrites stored HTML a
  // little on load (a trailing space, list markup), so the stored text
  // itself would always look changed.
  const loadedNotes = useRef(note ? note.notes_html || '' : '');
  const handleNotesChange = (value, _delta, source) => {
    if (source !== 'user') loadedNotes.current = value;
    setNotes(value);
  };
  const [attachments, setAttachments] = useState(note && note.attachments ? note.attachments.map(att => ({
    attachment_id: att.id,
    preview: att.image_base64 ? `data:${att.mime_type};base64,${att.image_base64}` : null,
    name: att.filename,
    file: null
  })) : []);
  const [selectedAttachment, setSelectedAttachment] = useState(null);
  const [summaryTouched, setSummaryTouched] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const modalRef = useRef(null);

  // Movable window on desktop (phones show it full screen).
  const drag = useDraggableWindow('dayNote', { enabled: window.matchMedia('(min-width: 601px)').matches });
  useScrollLock();
  const contentWrapperRef = useRef(null);

  const summaryError = !summary.trim();
  const canSave = !summaryError;

  const onDrop = (acceptedFiles) => {
    setAttachments(prev => [
      ...prev,
      ...acceptedFiles.map(file => ({
        preview: URL.createObjectURL(file),
        name: file.name,
        file: file
      }))
    ]);
  };
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'image/*': [] }
  });

  const handleRemoveAttachment = (idx) => {
    setAttachments(prev => prev.filter((_, i) => i !== idx));
  };

  const handleRequestClose = async () => {
    const initialMood = note && note.mood !== undefined ? note.mood : 1;
    const initialMarketCondition = note && note.market_condition !== undefined ? note.market_condition : 1;
    const initialMarketVolatility = note && note.market_volume !== undefined ? note.market_volume : 1;
    const initialDate = note ? formatDateForInput(new Date(note.date)) : getCurrentDate();
    const initialSummary = note ? note.summary || '' : '';
    const initialNotes = loadedNotes.current;
    const initialAttachments = note && note.attachments ? note.attachments.map(att => att.id) : [];

    const currentAttachments = attachments.map(att => att.attachment_id).filter(id => id);

    const hasChanges =
      mood !== initialMood ||
      marketCondition !== initialMarketCondition ||
      marketVolatility !== initialMarketVolatility ||
      date !== initialDate ||
      summary !== initialSummary ||
      notes !== initialNotes ||
      JSON.stringify(currentAttachments.sort()) !== JSON.stringify(initialAttachments.sort());

    if (hasChanges) {
      setSummaryTouched(true);
      const choice = await choiceDialog('You have unsaved changes. What do you want to do?', {
        title: 'Unsaved changes',
        choices: [
          { value: 'discard', label: "Don't save", kind: 'danger' },
          ...(canSave && !isSaving ? [{ value: 'save', label: 'Save', kind: 'primary' }] : []),
        ],
      });
      if (choice === 'save') saveDayNote();
      else if (choice === 'discard') onClose();
    } else {
      onClose();
    }
  };

  const requestDelete = async () => {
    if (await confirmDialog('This day note will be deleted. This cannot be undone.', { title: 'Delete this note?', confirmLabel: 'Delete', danger: true })) {
      deleteDayNote();
    }
  };

  const handleSummaryChange = (e) => {
    setSummary(e.target.value);
    setSummaryTouched(true);
  };

  async function saveDayNote() {
    if (isSaving) return;
    setIsSaving(true);
    try {
      const validMarketCondition = [0, 1, 2].includes(Number(marketCondition)) ? Number(marketCondition) : 1;
      const validMarketVolatility = [0, 1, 2].includes(Number(marketVolatility)) ? Number(marketVolatility) : 1;

      const normalizedDate = formatDateForInput(new Date(date));

      for (let i = 0; i < attachments.length; i++) {
        if (!attachments[i].attachment_id && attachments[i].file) {
          const formData = new FormData();
          formData.append('file', attachments[i].file);
          try {
            const resp = await fetch(`${process.env.REACT_APP_API_URL}/api/attachments`, {
              method: 'POST',
              headers: { 'X-Account-ID': noteAccountId },
              body: formData
            });
            if (!resp.ok) throw new Error('Attachment upload failed');
            const data = await resp.json();
            attachments[i].attachment_id = data.attachment_id;
          } catch (err) {
            console.error('Error uploading attachment:', err);
            notify('Failed to upload attachment');
            return;
          }
        }
      }

      const payload = {
        id: note?.id,
        date: normalizedDate,
        mood,
        marketCondition: validMarketCondition,
        marketVolume: validMarketVolatility,
        notes,
        summary,
        attachments: attachments.map(a => ({ attachment_id: a.attachment_id }))
      };

      try {
        const resp = await fetch(`${process.env.REACT_APP_API_URL}/api/daynotes`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Account-ID': noteAccountId,
          },
          body: JSON.stringify(payload)
        });

        if (resp.ok) {
          refreshTrades();
          onClose();
        } else {
          const errorText = await resp.text();
          console.error('Error saving day note:', errorText);
          notify(`Error saving day note: ${errorText}`);
        }
      } catch (err) {
        console.error('Network error saving day note:', err);
        notify('Network error saving day note');
      }
    } finally {
      setIsSaving(false);
    }
  }

  async function deleteDayNote() {
    if (!note || !note.id) return;

    try {
      const resp = await fetch(`${process.env.REACT_APP_API_URL}/api/daynotes/${note.id}`, {
        method: 'DELETE',
        headers: { 'X-Account-ID': noteAccountId },
      });

      if (resp.ok) {
        refreshTrades();
        onClose();
      } else {
        const errorText = await resp.text();
        console.error(`Error deleting day note ${note.id}:`, errorText);
        notify(`Error deleting day note: ${errorText}`);
      }
    } catch (err) {
      console.error(`Network error deleting day note ${note.id}:`, err);
      notify('Network error deleting day note');
    }
  }

  const quillModules = {
    toolbar: [
      ['bold', 'italic'],
      [{ 'header': [1, 2, false] }],
      [{ 'list': 'ordered'}, { 'list': 'bullet' }],
      ['link'],
      ['clean']
    ],
    // Without this, loading a note adds an empty line before each list
    // (Quill 1 guesses spacing from the margins), and saving keeps it.
    clipboard: { matchVisual: false },
  };

  useEffect(() => {
    const styleId = 'quill-dark-toolbar-daynote';
    if (!document.getElementById(styleId)) {
      const style = document.createElement('style');
      style.id = styleId;
      style.innerHTML = `
        .${styles.modal} .${styles.richText} .ql-toolbar {
          background: #161A24 !important;
          border-radius: 12px 12px 0 0 !important;
          border: none !important;
          color: #e0e2e6 !important;
        }
        .${styles.modal} .${styles.richText} .ql-toolbar button, 
        .${styles.modal} .${styles.richText} .ql-toolbar .ql-picker-label, 
        .${styles.modal} .${styles.richText} .ql-toolbar .ql-picker-item {
          color: #e0e2e6 !important;
          filter: brightness(1.5);
        }
        .${styles.modal} .${styles.richText} .ql-toolbar button.ql-active, 
        .${styles.modal} .${styles.richText} .ql-toolbar .ql-picker-label.ql-active,
        .${styles.modal} .${styles.richText} .ql-toolbar .ql-picker-item:hover {
          background: #3B82F6 !important;
          color: #fff !important;
        }
        .${styles.modal} .${styles.richText} .ql-toolbar .ql-picker-options {
          background: #161A24 !important;
          border: none !important;
          border-radius: 8px !important;
          color: #e0e2e6 !important;
        }
        .${styles.modal} .${styles.richText} .ql-container {
          background: #141822 !important;
          border-radius: 0 0 12px 12px !important;
          border: none !important;
          color: #e0e2e6 !important;
          min-height: 100 !important;
          max-height: 200px !important;
          overflow-y: auto !important;
        }
        .${styles.modal} .${styles.richText} .ql-editor {
          min-height: 120px !important;
          color: #e0e2e6 !important;
          border: none !important;
          padding: 12px 15px !important;
          background: transparent !important;
        }
        .${styles.modal} .${styles.richText} .ql-editor:focus {
          outline: none !important;
          border: none !important;
        }
        .${styles.modal} .${styles.richText} .ql-editor textarea {
          min-height: 220px !important;
          border: none !important;
          background: #141822 !important;
          color: #e0e2e6 !important;
          border-radius: 0 0 12px 12px !important;
        }
      `;
      document.head.appendChild(style);
    }

    return () => {
      const style = document.getElementById(styleId);
      if (style) {
        document.head.removeChild(style);
      }
    };
  }, []);


  return (
    <div className={styles.overlay}>
      <div
        className={`${styles.modal} ${drag.dragging ? styles.dragging : ''}`}
        ref={el => { modalRef.current = el; drag.setWindowEl(el); }}
        style={drag.windowStyle}
      >
        <div className={styles.headerRow} {...drag.dragHandleProps}>
          <span className={styles.title}>{note ? 'Edit Day Note' : 'New Day Note'}</span>
          <button className={styles.closeBtn} onClick={handleRequestClose} aria-label="Close">×</button>
        </div>
        <div className={styles.tabContent} ref={contentWrapperRef}>
          <div className={styles.moodGrid}>
            <div className={styles.moodField}>
              <label>Mood</label>
              <SegmentedRadio name="mood" value={mood} onChange={setMood} options={moodSvgs} />
            </div>
            <div className={styles.moodField}>
              <label>Mkt Condition</label>
              <SegmentedRadio
                name="mktCondition"
                value={marketCondition}
                onChange={(value) => {
                  setMarketCondition(value);
                }}
                options={mktConditionSvgs}
              />
            </div>
            <div className={styles.moodField}>
              <label>Mkt Volatility</label>
              <SegmentedRadio
                name="mktVolatility"
                value={marketVolatility}
                onChange={(value) => {
                  setMarketVolatility(value);
                }}
                options={mktVolSvgs}
              />
            </div>
          </div>
          <div className={styles.daySummary}>
            <span className={styles.daySummaryLabel}>That day</span>
            {dayTrades.length === 0 ? (
              <span className={styles.daySummaryEmpty}>No trades closed on this date</span>
            ) : (
              <>
                {dayPnl.map(({ currency, amount }) => (
                  <span key={currency} className={`${styles.dayChip} ${amount >= 0 ? styles.dayChipWin : styles.dayChipLoss}`}>
                    {amount >= 0 ? '+' : '−'}{formatMoney(Math.abs(amount), currency)}
                  </span>
                ))}
                <span className={styles.dayChip}>
                  {dayTrades.length} trade{dayTrades.length === 1 ? '' : 's'} · <span className={styles.dayWins}>{dayWins}W</span> / <span className={styles.dayLosses}>{dayLosses}L</span>
                </span>
                <span className={styles.dayChip} title={daySymbols.join(', ')}>
                  {daySymbols.slice(0, 4).join(' · ')}{daySymbols.length > 4 ? ` +${daySymbols.length - 4}` : ''}
                </span>
              </>
            )}
          </div>
          <div className={styles.journalTab}>
            <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
              <div className={styles.formField} style={{ width: 150 }}>
                <label htmlFor="daynote-date">Date</label>
                <input
                  id="daynote-date"
                  type="date"
                  className={styles.inputBubble}
                  value={date}
                  onChange={e => setDate(e.target.value)}
                  style={{ padding: '10px 16px', height: '44px', boxSizing: 'border-box' }}
                />
              </div>
              <div className={styles.formField} style={{ flex: 1 }}>
                <label htmlFor="daynote-summary">Summary</label>
                <input
                  id="daynote-summary"
                  className={`${styles.inputBubble} ${summaryTouched && summaryError ? styles.invalid : ''}`}
                  type="text"
                  value={summary}
                  onChange={handleSummaryChange}
                  onBlur={() => setSummaryTouched(true)}
                  autoComplete="off"
                  style={{ padding: '10px 16px', height: '44px', boxSizing: 'border-box' }}
                />
              </div>
            </div>
            <div className={styles.formFieldFull}>
              <label htmlFor="daynote-notes">Notes</label>
              <div className={styles.notesEditor}>
                <ReactQuill
                  id="daynote-notes"
                  theme="snow"
                  value={notes}
                  onChange={handleNotesChange}
                  className={styles.richText}
                  placeholder="Write your notes here..."
                  modules={quillModules}
                />
              </div>
            </div>
            <div className={styles.uploadRow}>
              <div {...getRootProps({ className: styles.uploadBtn })}>
                <input {...getInputProps()} />
                <div className={styles.iconContainer}>
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    className={styles.uploadIcon}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                    />
                  </svg>
                </div>
                {isDragActive ? "Drop images here..." : "Upload screenshots"}
              </div>
              <div className={styles.attachmentsPreview}>
                {attachments.map((att, i) => (
                  <div key={att.attachment_id || i} className={styles.attachmentThumb}>
                    <img
                      src={att.preview}
                      alt={att.name || 'attachment'}
                      title={att.name || 'attachment'}
                      style={{ width: 54, height: 54, borderRadius: 8, cursor: 'pointer' }}
                      onClick={() => setSelectedAttachment(att.preview)}
                    />
                    <span className={styles.tooltip}>{att.name || 'Unnamed file'}</span>
                    <button
                      className={styles.attachmentRemove}
                      onClick={() => handleRemoveAttachment(i)}
                      type="button"
                      aria-label="Remove attachment"
                    >×</button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
        <div className={styles.footerRow} style={{ justifyContent: 'flex-end' }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            {note && note.id && (
              <IconButton icon="trash" caption="Delete" label="Delete this note" onClick={requestDelete} />
            )}
            <IconButton
              icon="check"
              caption="Save"
              label="Save"
              onClick={() => {
                if (canSave) {
                  saveDayNote();
                } else {
                  setSummaryTouched(true);
                }
              }}
              disabled={!canSave}
              busy={isSaving}
            />
          </div>
        </div>
        {selectedAttachment && (
          <div
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(0,0,0,0.8)',
              zIndex: 2000,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            <div
              style={{
                background: '#161A24',
                borderRadius: 18,
                padding: 16,
                maxWidth: '90vw',
                maxHeight: '90vh',
                position: 'relative',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center'
              }}
            >
              <img
                src={selectedAttachment}
                alt="Full-size attachment"
                style={{
                  maxWidth: '100%',
                  maxHeight: '80vh',
                  borderRadius: 8,
                  objectFit: 'contain'
                }}
              />
              <button
                onClick={() => setSelectedAttachment(null)}
                style={{
                  position: 'absolute',
                  top: -12,
                  right: -12,
                  background: '#ef4444',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '50%',
                  width: 32,
                  height: 32,
                  fontSize: '1.2em',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  zIndex: 2,
                  boxShadow: '0 2px 8px 0 rgba(0,0,0,0.22)',
                  lineHeight: 1,
                  padding: 0
                }}
              >
                ×
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}