import { FormEvent, useEffect, useState } from 'react';
import { api, Team } from '../api';
import { Button, Field, Modal, useToast } from './ui';

export function TeamFormModal({ open, onClose, team, onSaved }: { open: boolean; onClose: () => void; team?: Team; onSaved: (t: Team) => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [aliases, setAliases] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setName(team?.name ?? ''); setCode(team?.code ?? ''); setAliases(team?.aliases.join('\n') ?? ''); setNotes(team?.notes ?? ''); setErr(null);
  }, [open, team]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    const body = { name, code, aliases: aliases.split(/[\n,;]/).map((a) => a.trim()).filter(Boolean), notes };
    try {
      const t = team ? await api.patch<Team>(`/api/teams/${team.id}`, body) : await api.post<Team>('/api/teams', body);
      toast.ok(team ? 'Zapisano zmiany drużyny' : `Dodano drużynę ${t.name}`);
      onSaved(t);
      onClose();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title={team ? 'Edytuj drużynę' : 'Nowa drużyna'}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <Field label="Nazwa" className="col-span-2"><input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} placeholder="np. Poland" /></Field>
          <Field label="Kod" hint="Kod kraju / organizatora"><input className="input font-mono uppercase" value={code} onChange={(e) => setCode(e.target.value)} required maxLength={20} placeholder="POL" /></Field>
        </div>
        <Field label="Aliasy nazwy" hint="Inne zapisy używane w deklaracjach, po jednym w linii (np. „Polska”, „POL Sailing Team”).">
          <textarea className="input min-h-[72px]" value={aliases} onChange={(e) => setAliases(e.target.value)} />
        </Field>
        <Field label="Notatki"><textarea className="input min-h-[56px]" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        {err && <p role="alert" className="text-sm text-red-300">{err}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>Anuluj</Button>
          <Button type="submit" variant="primary" busy={busy}>{team ? 'Zapisz' : 'Dodaj drużynę'}</Button>
        </div>
      </form>
    </Modal>
  );
}
