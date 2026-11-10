export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: any) { super(message); }
}

// ---------- static commentator page: answers come from one data.json written by the venue PC ----------
interface StaticFeed { pushedAt: string; version: string; routes: Record<string, unknown> }
interface StaticStatus { pushedAt: string; version: string }
let staticBase: string | null = null;
let statusLoad: { at: number; p: Promise<StaticStatus> } | null = null;
let feedCache: Promise<StaticFeed> | null = null;
let feedVersion = '';
/** Static page: read status.json and data.json from this folder ('' = the page's own folder). */
export function setStaticSource(base: string) { staticBase = base; }
export const isStatic = () => staticBase !== null;

const getJson = <T,>(name: string): Promise<T> =>
  fetch(`${staticBase}${name}?t=${Date.now()}`, { cache: 'no-store' }).then(async (r) => {
    if (!r.ok) throw new ApiError(r.status, r.status === 404 ? 'No data from the venue yet.' : `Cannot load the data (HTTP ${r.status}).`);
    return r.json() as Promise<T>;
  }, () => { throw new ApiError(0, 'No connection. The screen will retry by itself.'); });

/** status.json is tiny and read every round; the big data.json only when its version changed. */
function loadStatus(): Promise<StaticStatus> {
  if (statusLoad && Date.now() - statusLoad.at < 2_500) return statusLoad.p;
  const p = getJson<StaticStatus>('status.json');
  statusLoad = { at: Date.now(), p };
  p.catch(() => { statusLoad = null; });
  return p;
}
async function loadFeed(): Promise<StaticFeed> {
  const st = await loadStatus().catch(() => null);
  if (!feedCache || (st && st.version !== feedVersion)) {
    const p = getJson<StaticFeed>('data.json');
    feedCache = p;
    feedVersion = st?.version ?? '';
    p.catch(() => { if (feedCache === p) { feedCache = null; feedVersion = ''; } });
  }
  return feedCache;
}

async function staticGet<T>(url: string): Promise<T> {
  const [path, qs = ''] = url.split('?');
  if (path === '/api/live/status') { const st = await loadStatus(); return { feed: { pushedAt: st.pushedAt, receivedAt: st.pushedAt }, now: new Date().toISOString() } as T; }
  const feed = await loadFeed();
  const set = new URLSearchParams(qs).get('set');
  const key = set && (path === '/api/overview' || path === '/api/commentator') ? `${path}?set=${set}` : path;
  if (!(key in feed.routes)) throw new ApiError(404, 'Not in the commentator data.');
  return feed.routes[key] as T;
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  if (staticBase !== null) {
    if (method !== 'GET') throw new ApiError(403, 'This screen is read-only.');
    return staticGet<T>(url);
  }
  // The commentator screen at /live reads the snapshot pushed by the venue PC when there is one.
  const onLive = window.location.pathname === '/live';
  const init: RequestInit = { method, headers: onLive ? { 'x-ssl-live': '1' } : {} };
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
  if (res.status === 401 && !onLive) window.location.href = '/login';
  if (res.status === 401) throw new ApiError(401, 'This commentator link is no longer valid. Ask the operator for the new one.');
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
