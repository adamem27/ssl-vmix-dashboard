import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { cx, useToast } from './ui';

interface StageInfo { current: { id: string; name: string } | null; stages: { id: string; name: string }[] }
export const useStage = () => useQuery({ queryKey: ['stage'], queryFn: () => api.get<StageInfo>('/api/stage') });

/** The stage the event is in (a fleet set): the Excel file for vMix lists only its teams, sailors and groups. */
export function StagePicker() {
  const q = useStage();
  const qc = useQueryClient();
  const toast = useToast();
  if (!q.data) return null;
  const set = async (setId: string) => {
    try { qc.setQueryData(['stage'], await api.put<StageInfo>('/api/stage', { setId: setId || null })); qc.invalidateQueries({ queryKey: ['workbook'] }); }
    catch (e) { toast.error(e); }
  };
  return (
    <label className="flex items-center gap-1.5 text-xs text-ink-400" title="Teams, Sailors and Results in the Excel file for vMix follow the stage chosen here">
      Stage
      <select className={cx('input w-auto max-w-[14rem] py-1 text-xs', q.data.current ? 'border-accent-600 text-accent-200' : 'text-ink-300')} value={q.data.current?.id ?? ''}
        onChange={(e) => void set(e.target.value)} aria-label="Current stage">
        <option value="">All teams (no stage)</option>
        {q.data.stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </label>
  );
}
