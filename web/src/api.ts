export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: any) { super(message); }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: {} };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
  }
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiError(0, 'Cannot reach the dashboard server. Check that the backend is running.');
  }
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  // Logged out (online mode): back to the login form.
  if (res.status === 401) window.location.href = '/login';
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Server error (HTTP ${res.status}).`, data?.details);
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  put: <T>(url: string, body?: unknown) => request<T>('PUT', url, body ?? {}),
  patch: <T>(url: string, body?: unknown) => request<T>('PATCH', url, body ?? {}),
  del: <T>(url: string) => request<T>('DELETE', url),
  upload: <T>(url: string, file: File) => { const fd = new FormData(); fd.append('file', file); return request<T>('POST', url, fd); },
};

export interface SlotDef { key: string; label: string }
export interface EventInfo { id: string; name: string; timezone: string; year: number }
export interface Meta { event: EventInfo; teamSlots: SlotDef[]; sailorSlots: SlotDef[]; hasDemo: boolean }

export interface Asset {
  id: string; slot: string; storageKind: 'upload' | 'path'; originalFilename: string; mime: string | null;
  width: number | null; height: number | null; sizeBytes: number | null; storedPath: string | null; enteredPath: string | null;
  vmixPath: string | null; vmixPathNote: string; previewUrl: string | null;
  checkStatus: 'stored' | 'reachable' | 'unverified' | 'invalid'; checkMessage: string; checkedAt: string | null; updatedAt: string;
}

export interface Team {
  id: string; name: string; code: string; nickname: string; aliases: string[]; notes: string; isDemo: boolean; updatedAt: string;
  ranking: string; rankingSource: string | null; rankingPoints: string; rankingManual: boolean; rankingFetchedAt: string | null;
  assets: Record<string, Asset>; assetsFilled: number; assetsTotal: number;
  thumb: { slot: string; previewUrl: string | null; checkStatus: string } | null; sailorCount: number;
}

export interface Sailor {
  id: string; teamId: string; firstName: string; lastName: string; defaultPosition: string; defaultNumber: string;
  bestResult1: string; bestResult2: string; bestResult3: string; sourceRef: string | null; isDemo: boolean; isCaptain: boolean; updatedAt: string; photo: Asset | null;
}
export interface SailorDetail extends Sailor {
  history: { date: string; teamId: string; memberId: string; position: string; number: string; hasOverride: number; origin: string }[];
  sourceAliases: { nameKey: string }[];
}

export interface FleetSetSummary { id: string; name: string; fleetCount: number; assignedCount: number; updatedAt: string }
export interface FleetSetDetail {
  set: { id: string; name: string; updatedAt: string };
  fleets: { id: string; name: string; size: number; positions: (string | null)[]; placeholders: (string | null)[]; filled: number; complete: boolean }[];
  assignedTeamIds: string[];
}

export interface FieldValue { value: string; source: string | null; manual: string | null; origin: 'manual' | 'source' | 'empty' }
export interface Member {
  id: string; origin: 'manual' | 'import'; sort: number; sourceName: string | null; inSource: boolean; hasSource: boolean;
  matchStatus: 'matched' | 'unmatched' | 'ambiguous' | 'manual'; sailorLocked: boolean;
  sailor: { id: string; firstName: string; lastName: string; defaultPosition: string; defaultNumber: string; photo: Asset | null } | null;
  position: FieldValue; number: FieldValue; weight: FieldValue; overrideUpdatedAt: string | null;
}
export interface Declaration {
  id: string; teamId: string; date: string; origin: 'manual' | 'import'; sourceRef: string | null; sourcePostedRaw: string | null;
  sourceFetchedAt: string | null; notes: string; createdAt: string; updatedAt: string; members: Member[];
  totalWeight: string; sourceTotalWeight: string | null;
}
export interface DateOverviewRow {
  teamId: string; name: string; code: string; isDemo: number; declarationId: string | null; origin: string | null;
  sourceFetchedAt: string | null; members: number; unmatched: number; overrides: number; totalWeight: number | null;
}

export interface ImportSummary {
  declarationsInSource: number; declarationsAdded: number; declarationsUpdated: number; declarationsUnchanged: number;
  membersAdded: number; membersChanged: number; membersRemoved: number; membersUnmatched: number;
  conflicts: { team: string; date: string; name: string; field: 'position' | 'number'; manual: string; source: string }[];
  warnings: string[]; unmatchedTeams: string[];
}
export interface SyncRun {
  id: string; trigger: string; importer: string; sourceUrl: string; startedAt: string; finishedAt: string | null;
  status: 'running' | 'success' | 'error'; error: string | null; summary: ImportSummary | null;
}
export interface SyncStatus {
  url: string; enabled: boolean; intervalMinutes: number; importer: string;
  importers: { id: string; label: string; description: string }[];
  running: boolean; lastAttemptAt: string | null; lastSuccessAt: string | null; nextRunAt: string | null; backendStartedAt: string;
  lastRun: SyncRun | null;
}
export interface RankingResult { rows: number; matched: number; teamsWithoutRanking: string[]; fetchedAt: string; source: 'live' | 'snapshot' }
export interface RunOutcome { status: 'success' | 'error' | 'already_running'; error?: string; summary?: ImportSummary }

export interface SettingsInfo {
  event: EventInfo;
  paths: { dataDir: string | null; dbPath: string | null; assetsDir: string; vmixAssetsRoot: string };
  hasDemo: boolean;
}

export interface OverviewSailor extends Sailor { declared: { position: string; number: string; weight: string; manual: boolean; sort: number } | null }
export interface OverviewTeam {
  id: string; code: string; name: string; nickname: string; ranking: string; rankingManual: boolean; rankingPoints: string; isDemo: boolean; thumb: Team['thumb']; assets: Record<string, Asset>;
  slots: { key: string; label: string; status: Asset['checkStatus'] | 'missing' }[]; assetsFilled: number; assetsTotal: number;
  place: { fleetName: string; position: number } | null;
  declaration: { members: number; totalWeight: string; unmatched: { name: string; position: string; number: string; weight: string }[] } | null;
  sailors: OverviewSailor[];
}
export interface Overview { date: string; fleetSetId: string | null; teams: OverviewTeam[] }
