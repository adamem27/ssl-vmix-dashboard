import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { cx, useToast } from './ui';

interface StageInfo { current: { id: string; name: string } | null; teamIds: string[] | null; stages: { id: string; name: string }[] }
export const useStage = () => useQuery({ queryKey: ['stage'], queryFn: () => api.get<StageInfo>('/api/stage') });

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

/** The stage the event is in (a fleet set): the Excel file for vMix lists only its teams, sailors and groups. */
export function StagePicker() {
  const q = useStage();
  const qc = useQueryClient();
  const toast = useToast();
  if (!q.data) return null;
  const set = async (setId: string) => {
    try { qc.setQueryData(['stage'], await api.put<StageInfo>('/api/stage', { setId: setId || null })); qc.invalidateQueries({ queryKey: ['workbook'] }); qc.invalidateQueries({ queryKey: ['results'] }); }
    catch (e) { toast.error(e); }
  };
  return (
    <label className="flex items-center gap-1.5 text-xs text-ink-400" title="Every tab and the Excel file for vMix show only the teams of the stage chosen here">
      Stage
      <select className={cx('input w-auto max-w-[14rem] py-1 text-xs', q.data.current ? 'border-accent-600 text-accent-200' : 'text-ink-300')} value={q.data.current?.id ?? ''}
        onChange={(e) => void set(e.target.value)} aria-label="Current stage">
        <option value="">All teams (no stage)</option>
        {q.data.stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </label>
  );
}
