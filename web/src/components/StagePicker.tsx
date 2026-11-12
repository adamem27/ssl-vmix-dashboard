import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { cx, setDayOverride, useToast } from './ui';

export interface StageGroup { id: string; name: string; label: string; letter: string }
interface StageInfo {
  /** the day the dashboard works on ('' = today) and the real today */
  day: string; today: string;
  current: { id: string; name: string } | null; teamIds: string[] | null; stages: { id: string; name: string }[];
  /** groups of the current stage, and the group racing now */
  groups: StageGroup[]; group: (StageGroup & { setId: string }) | null;
}
export const useStage = () => useQuery({ queryKey: ['stage'], queryFn: async () => { const d = await api.get<StageInfo>('/api/stage'); setDayOverride(d.day ?? ''); return d; } });

/**
 * The teams of the current stage. Every tab lists only these while a stage is picked;
 * with no stage (or before it loads) every team is shown.
 */
export function useStageTeams() {
  const q = useStage();
  const teamIds = q.data?.teamIds;
  return useMemo(() => {
    const ids = teamIds ? new Set(teamIds) : null;
    return { stage: q.data?.current ?? null, ids, order: teamIds ?? null, inStage: (id: string) => !ids || ids.has(id) };
  }, [teamIds, q.data?.current]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** One line saying the list is limited to the current stage. */
export function StageNote({ shown, total }: { shown: number; total: number }) {
  const { stage } = useStageTeams();
  if (!stage || shown === total) return null;
  return <p className="text-xs text-accent-300">Stage {stage.name}: showing {shown} of {total} teams. Pick “All teams” in Stage at the top to see the rest.</p>;
}

/**
 * The stage the event is in (a group set) and the group racing now. The Excel file for vMix lists only the stage's
 * teams, sailors and groups; Show control's team keys, the tickers and the results boards follow the group.
 */
export function StagePicker() {
  const q = useStage();
  const qc = useQueryClient();
  const toast = useToast();
  if (!q.data) return null;
  const after = (d: StageInfo) => {
    qc.setQueryData(['stage'], d);
    for (const k of ['workbook', 'results', 'show', 'graphic-sets', 'schedule']) qc.invalidateQueries({ queryKey: [k] });
  };
  const setDay = async (day: string) => {
    try {
      const d = await api.put<StageInfo>('/api/stage/day', { day });
      setDayOverride(d.day ?? '');
      qc.setQueryData(['stage'], d);
      // every tab works on the picked day: everything is read again
      void qc.invalidateQueries({ predicate: (x) => x.queryKey[0] !== 'stage' });
    } catch (e) { toast.error(e); }
  };
  const day = q.data.day || q.data.today;
  const set = async (setId: string) => {
    try { after(await api.put<StageInfo>('/api/stage', { setId: setId || null })); } catch (e) { toast.error(e); }
  };
  const setGroup = async (fleetId: string) => {
    try { after(await api.put<StageInfo>('/api/stage/group', { fleetId })); } catch (e) { toast.error(e); }
  };
  return (
    <div className="flex items-center gap-3">
      <label className="flex items-center gap-1.5 text-xs text-ink-400" title="The day the whole dashboard works on: line-ups, schedule, Welcome, tickers, the Excel file for vMix. Today unless you pick another day.">
        Date
        <input type="date" className={cx('input w-auto py-1 text-xs', q.data.day && q.data.day !== q.data.today ? 'border-amber-500 text-amber-200' : 'text-ink-300')} value={day}
          onChange={(e) => void setDay(e.target.value === q.data.today ? '' : e.target.value)} aria-label="Day the dashboard works on" />
        {q.data.day && q.data.day !== q.data.today && <button className="rounded px-1.5 py-0.5 text-xs text-amber-300 hover:bg-ink-800" onClick={() => void setDay('')}>Today</button>}
      </label>
      <label className="flex items-center gap-1.5 text-xs text-ink-400" title="Every tab and the Excel file for vMix show only the teams of the stage chosen here">
        Stage
        <select className={cx('input w-auto max-w-[14rem] py-1 text-xs', q.data.current ? 'border-accent-600 text-accent-200' : 'text-ink-300')} value={q.data.current?.id ?? ''}
          onChange={(e) => void set(e.target.value)} aria-label="Current stage">
          <option value="">All teams (no stage)</option>
          {q.data.stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>
      {q.data.current && (
        <label className="flex items-center gap-1.5 text-xs text-ink-400" title="The group racing now: Show control's team keys, the tickers and the results boards follow it">
          Racing
          <select className={cx('input w-auto max-w-[10rem] py-1 text-xs font-semibold', q.data.group ? 'border-red-700 text-red-200' : 'text-ink-300')} value={q.data.group?.id ?? ''}
            onChange={(e) => void setGroup(e.target.value)} aria-label="Group racing now">
            <option value="">—</option>
            {q.data.groups.map((g) => <option key={g.id} value={g.id}>{g.label}{g.label.endsWith(g.name.toUpperCase()) ? '' : ` (${g.name})`}</option>)}
          </select>
        </label>
      )}
    </div>
  );
}
