import { FormEvent, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, Sailor, SailorDetail } from '../api';
import { AssetSlot } from './AssetSlot';
import { Button, Field, Modal, useToast } from './ui';

const EMPTY = { firstName: '', lastName: '', defaultPosition: '', defaultNumber: '', bestResult1: '', bestResult2: '' };

export function SailorFields({ value, onChange }: { value: typeof EMPTY; onChange: (v: typeof EMPTY) => void }) {
  const f = (k: keyof typeof EMPTY) => ({ value: value[k], onChange: (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value }) });
  return (
    <div className="grid grid-cols-6 gap-3">
      <Field label="First name" className="col-span-3"><input className="input" {...f('firstName')} maxLength={80} /></Field>
      <Field label="Last name" className="col-span-3"><input className="input" {...f('lastName')} maxLength={80} /></Field>
      <Field label="Position (default)" className="col-span-4"><input className="input" {...f('defaultPosition')} maxLength={80} placeholder="e.g. Helm" /></Field>
      <Field label="Number (default)" className="col-span-2"><input className="input tabular-nums" {...f('defaultNumber')} maxLength={10} placeholder="e.g. 7" /></Field>
      <Field label="Best results 1" className="col-span-6"><input className="input" {...f('bestResult1')} maxLength={500} /></Field>
      <Field label="Best results 2" className="col-span-6"><input className="input" {...f('bestResult2')} maxLength={500} /></Field>
    </div>
  );
}

export function sailorToForm(s?: Sailor | null) {
  return s ? { firstName: s.firstName, lastName: s.lastName, defaultPosition: s.defaultPosition, defaultNumber: s.defaultNumber, bestResult1: s.bestResult1, bestResult2: s.bestResult2 } : { ...EMPTY };
}

export function SailorFormModal({ open, onClose, teamId, sailor }: { open: boolean; onClose: () => void; teamId: string; sailor?: Sailor | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [current, setCurrent] = useState<Sailor | null>(sailor ?? null);
  const [form, setForm] = useState(sailorToForm(sailor));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setCurrent(sailor ?? null); setForm(sailorToForm(sailor)); setErr(null); } }, [open, sailor]);

  const refresh = () => { qc.invalidateQueries({ queryKey: ['sailors', teamId] }); qc.invalidateQueries({ queryKey: ['teams'] }); };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const s = current ? await api.patch<SailorDetail>(`/api/sailors/${current.id}`, form) : await api.post<SailorDetail>(`/api/teams/${teamId}/sailors`, form);
      toast.ok(current ? 'Sailor profile saved' : `Sailor ${s.firstName} ${s.lastName} added. You can add a photo now.`);
      refresh();
      if (current) onClose(); else setCurrent(s);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  const reloadPhoto = async () => {
    if (!current) return;
    setCurrent(await api.get<SailorDetail>(`/api/sailors/${current.id}`));
    refresh();
  };

  return (
    <Modal open={open} onClose={onClose} title={current ? `${current.firstName} ${current.lastName}`.trim() || 'Sailor' : 'New sailor'} wide>
      <form onSubmit={submit} className="grid gap-5 md:grid-cols-[220px_1fr]">
        <div>
          {current ? (
            <AssetSlot ownerKind="sailors" ownerId={current.id} slot={{ key: 'photo', label: 'Photo' }} asset={current.photo} bg="dark" accept="png+jpg" aspect="aspect-[4/5]" onChanged={reloadPhoto} />
          ) : (
            <div className="flex aspect-[4/5] items-center justify-center rounded-xl border border-dashed border-ink-700 p-4 text-center text-xs text-ink-500">Add a photo after saving the sailor.</div>
          )}
        </div>
        <div className="space-y-4">
          <SailorFields value={form} onChange={setForm} />
          {err && <p role="alert" className="text-sm text-red-300">{err}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={onClose}>{current && !sailor ? 'Done' : 'Cancel'}</Button>
            <Button type="submit" variant="primary" busy={busy}>{current ? 'Save' : 'Add sailor'}</Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
