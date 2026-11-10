import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { ErrorBox, Loading, useToast } from '../components/ui';
import { Cell } from '../components/cells';
import { useStage } from '../components/StagePicker';

type TeamField = 'name' | 'nick' | 'rank' | 'weight' | 'cptName' | 'cptSurname' | 'flag' | 'emblem' | 'photo' | 'panel';
interface CompareGroup {
  fleetId: string; name: string; group: string; title: string;
  teams: { n: number; team: { id: string; code: string; name: string } | null; values: Record<TeamField, string>; panelFound: boolean }[];
  over: { title?: string; group?: string; teams?: Record<string, Partial<Record<TeamField, string>>> };
}
interface CompareTab { stage: string; groups: CompareGroup[] }

const TEXTS: [TeamField, string][] = [['name', 'Country'], ['nick', 'Nickname'], ['rank', 'SSL rank'], ['weight', 'Weight (kg)'], ['cptName', 'Captain name'], ['cptSurname', 'Captain surname']];
const PICS: [TeamField, string][] = [['flag', 'Flag'], ['emblem', 'Emblem'], ['photo', 'Captain photo'], ['panel', 'Panel (background)']];
const isAsset = (v: string) => !!v && !/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(v);
const file = (p: string) => p.split(/[\\/]/).pop() ?? p;

/**
 * General graphics → Team comparison: each group of the stage picked at the top, what the Team comparison title gets
 * for it (filled from Teams, line-ups, declarations and the PNG generator) and what is typed over it. An empty field
 * goes back to the dashboard's value.
 */
export function ComparePanel() {
  const qc = useQueryClient();
  const toast = useToast();
  const stage = useStage().data?.current?.id ?? '';
  const q = useQuery({ queryKey: ['compare', stage], queryFn: () => api.get<CompareTab>('/api/compare') });
  const save = async (fleetId: string, n: number, field: string, value: string) => {
    try { await api.put(`/api/compare/${fleetId}`, { n, field, value }); await qc.invalidateQueries({ queryKey: ['compare'] }); } catch (e) { toast.error(e); throw e; }
  };
  const upload = async (fleetId: string, n: number, field: string, f: File | undefined) => {
    if (!f) return;
    try { const r = await api.upload<{ path: string }>('/api/compare/upload', f); await save(fleetId, n, field, r.path); } catch (e) { toast.error(e); }
  };
  return (
    <section className="card">
      <header className="flex flex-wrap items-center gap-2 border-b border-ink-800 px-3 py-2">
        <h2 className="text-sm font-bold uppercase tracking-wide text-ink-200">Team comparison</h2>
        <span className="text-xs text-ink-500">{q.data?.stage ? `Stage: ${q.data.stage}` : 'All stages (pick a stage at the top)'} · grey values come from the dashboard; type over them to change what the title shows</span>
      </header>
      <div className="space-y-3 p-2">
        {q.isLoading && <Loading />}
        {q.error && <ErrorBox error={q.error} />}
        {q.data && !q.data.groups.length && <p className="px-1 py-4 text-sm text-ink-500">No groups in this stage yet.</p>}
        {q.data?.groups.map((g) => (
          <div key={g.fleetId} className="rounded border border-ink-800">
            <div className="grid grid-cols-2 gap-2 border-b border-ink-800 bg-ink-900/60 p-2 md:grid-cols-4">
              <Field label="Group">
                <Cell value={g.over.group ?? ''} placeholder={g.group} onSave={(v) => save(g.fleetId, 0, 'group', v)} label="Group" />
              </Field>
              <Field label="Title">
                <Cell value={g.over.title ?? ''} placeholder={g.title || '—'} onSave={(v) => save(g.fleetId, 0, 'title', v)} label="Title" />
              </Field>
            </div>
            <div className="grid gap-2 p-2 md:grid-cols-2 xl:grid-cols-4">
              {g.teams.map((t) => {
                const ov = g.over.teams?.[String(t.n)] ?? {};
                return (
                  <div key={t.n} className="min-w-0 rounded border border-ink-800 p-2">
                    <div className="mb-1 text-xs font-semibold text-ink-300">{t.n}. {t.team ? `${t.team.code} · ${t.team.name}` : 'empty place'}</div>
                    <div className="grid grid-cols-2 gap-x-2 gap-y-1">
                      {TEXTS.map(([k, label]) => (
                        <Field key={k} label={label}>
                          <Cell value={ov[k] ?? ''} placeholder={t.values[k] || '—'} onSave={(v) => save(g.fleetId, t.n, k, v)} label={`${t.n} ${label}`} />
                        </Field>
                      ))}
                      {PICS.map(([k, label]) => {
                        const auto = k === 'panel' && !t.panelFound ? '(title’s own)' : file(t.values[k]) || '—';
                        return (
                          <Field key={k} label={label} wide>
                            <div className="flex items-center gap-1">
                              {ov[k] && isAsset(ov[k]!) && (
                                <img src={`/api/gtzip/image?src=${encodeURIComponent(`asset:${ov[k]}`)}`} alt="" className="h-7 w-7 shrink-0 rounded border border-ink-800 object-contain" />
                              )}
                              <div className="min-w-0 flex-1">
                                <Cell value={ov[k] ?? ''} placeholder={auto} onSave={(v) => save(g.fleetId, t.n, k, v)} label={`${t.n} ${label}`} />
                              </div>
                              <label className="inline-flex cursor-pointer items-center whitespace-nowrap rounded border border-ink-700 bg-ink-800 px-2 py-0.5 text-[11px] text-ink-100 hover:bg-ink-700" title="Upload a PNG or JPG for this place (it is used instead of the dashboard's picture; clear the field to go back)">
                                Upload
                                <input type="file" accept="image/png,image/jpeg" className="hidden" onChange={(e) => { void upload(g.fleetId, t.n, k, e.target.files?.[0]); e.target.value = ''; }} />
                              </label>
                            </div>
                          </Field>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Field({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className={wide ? 'col-span-2 min-w-0' : 'min-w-0'}>
      <div className="px-1 text-[10px] font-semibold uppercase tracking-wide text-ink-500">{label}</div>
      {children}
    </div>
  );
}
