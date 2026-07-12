'use client';

import { useEffect, useRef, useState } from 'react';

export interface FormModalField {
  name: string;
  label: string;
  type?: 'text' | 'textarea' | 'select';
  defaultValue?: string;
  placeholder?: string;
  required?: boolean;
  options?: { value: string; label: string }[]; // for select
  mono?: boolean; // monospace input (SQL, cron)
}

/** Generic small form dialog — replaces chained window.prompt() flows (pin,
 *  bookmark, schedule, promote, save-verified, notebook title). One dialog with
 *  all fields instead of sequential prompts; Esc/backdrop closes; first field
 *  autofocused. Values come back as a name→string map. */
export function FormModal({ open, title, fields, submitLabel = 'Save', onSubmit, onClose }: {
  open: boolean;
  title: string;
  fields: FormModalField[];
  submitLabel?: string;
  onSubmit: (values: Record<string, string>) => void;
  onClose: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const firstRef = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null>(null);

  // Re-seed defaults each time the dialog opens (fields may differ per action).
  useEffect(() => {
    if (!open) return;
    const init: Record<string, string> = {};
    for (const f of fields) init[f.name] = f.defaultValue ?? (f.type === 'select' ? f.options?.[0]?.value ?? '' : '');
    setValues(init);
    setTimeout(() => firstRef.current?.focus(), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const missing = fields.some((f) => f.required && !values[f.name]?.trim());

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (missing) return;
    onSubmit(values);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={onClose} data-testid="form-modal">
      <form onSubmit={submit} onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-md space-y-3 rounded-lg border border-neutral-200 bg-white p-4 shadow-xl dark:border-neutral-700 dark:bg-neutral-900">
        <div className="text-sm font-semibold">{title}</div>
        {fields.map((f, i) => {
          const common = {
            value: values[f.name] ?? '',
            onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
              setValues((v) => ({ ...v, [f.name]: e.target.value })),
            className: `w-full rounded border p-2 text-sm dark:bg-neutral-950 ${f.mono ? 'font-mono text-xs' : ''}`,
            placeholder: f.placeholder,
          };
          return (
            <label key={f.name} className="block text-xs text-neutral-600 dark:text-neutral-300">
              {f.label}{f.required && <span className="text-red-500"> *</span>}
              <div className="mt-1">
                {f.type === 'textarea' ? (
                  <textarea {...common} rows={4} ref={i === 0 ? (el) => { firstRef.current = el; } : undefined} />
                ) : f.type === 'select' ? (
                  <select {...common} ref={i === 0 ? (el) => { firstRef.current = el; } : undefined}>
                    {(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                ) : (
                  <input {...common} ref={i === 0 ? (el) => { firstRef.current = el; } : undefined} />
                )}
              </div>
            </label>
          );
        })}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="rounded border px-3 py-1 text-sm">Cancel</button>
          <button type="submit" disabled={missing} className="rounded bg-blue-600 px-3 py-1 text-sm text-white disabled:opacity-50">{submitLabel}</button>
        </div>
      </form>
    </div>
  );
}
