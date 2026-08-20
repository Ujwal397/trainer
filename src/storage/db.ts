/**
 * IndexedDB persistence for sessions/settings/sensitivity profiles. No
 * external libraries — just a thin Promise wrapper.
 *
 * This is the one place in the app allowed to touch browser storage APIs
 * (see `src/core/types.ts` header: `src/core` must stay DOM-free, `src/storage`
 * may not).
 *
 * Two things this file specifically has to survive:
 *  - IndexedDB being unavailable (Safari/Firefox private browsing, some
 *    embedded webviews, and — usefully for tests — plain Node/vitest, which
 *    has no `indexedDB` global at all). `createDb()` detects this and falls
 *    back to an in-memory store with the *same* async API, exposing
 *    `isPersistent: false` so the UI can warn the user their runs won't
 *    survive a reload.
 *  - Quota exceeded errors, which must surface clearly (see `StorageQuotaError`)
 *    rather than silently dropping data.
 */
import type { AimSample, SensConfig, SessionRecord } from '../core/types';

// ------------------------------------------------------------------ errors --

export class StorageQuotaError extends Error {
  constructor(cause?: unknown) {
    super('Storage quota exceeded — delete old sessions or export and clear them before recording more.');
    this.name = 'StorageQuotaError';
    if (cause !== undefined) this.cause = cause;
  }
}

export class StorageUnavailableError extends Error {
  constructor(message = 'Storage backend is unavailable.') {
    super(message);
    this.name = 'StorageUnavailableError';
  }
}

// ------------------------------------------------------------ packed rows --

/**
 * Compact typed-array encoding of `AimSample[]`. A 60s session at 250Hz is
 * ~15k samples; as an array of `{t,yaw,pitch,dx,dy,gain}` objects that's
 * roughly 6 boxed numbers + object/array overhead per sample (V8 typically
 * lands well north of 100 bytes/sample once you include hidden-class and GC
 * bookkeeping). Six parallel `Float32Array`s store the same data in exactly
 * 24 bytes/sample with no per-sample object overhead — about an order of
 * magnitude smaller, which is the difference between IndexedDB rows staying
 * manageable and a week of daily training sessions bloating storage into
 * the hundreds of MB.
 */
export interface PackedSamples {
  count: number;
  t: Float32Array;
  yaw: Float32Array;
  pitch: Float32Array;
  dx: Float32Array;
  dy: Float32Array;
  gain: Float32Array;
}

export function packSamples(samples: AimSample[]): PackedSamples {
  const n = samples.length;
  const t = new Float32Array(n);
  const yaw = new Float32Array(n);
  const pitch = new Float32Array(n);
  const dx = new Float32Array(n);
  const dy = new Float32Array(n);
  const gain = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    t[i] = s.t;
    yaw[i] = s.yaw;
    pitch[i] = s.pitch;
    dx[i] = s.dx;
    dy[i] = s.dy;
    gain[i] = s.gain;
  }
  return { count: n, t, yaw, pitch, dx, dy, gain };
}

export function unpackSamples(packed: PackedSamples): AimSample[] {
  const out: AimSample[] = new Array(packed.count);
  for (let i = 0; i < packed.count; i++) {
    out[i] = { t: packed.t[i], yaw: packed.yaw[i], pitch: packed.pitch[i], dx: packed.dx[i], dy: packed.dy[i], gain: packed.gain[i] };
  }
  return out;
}

/** How a session is actually stored — `samples` swapped for its packed form. */
type StoredSession = Omit<SessionRecord, 'samples'> & { packedSamples: PackedSamples };

function toStored(session: SessionRecord): StoredSession {
  const { samples, ...rest } = session;
  return { ...rest, packedSamples: packSamples(samples) };
}

function fromStored(row: StoredSession): SessionRecord {
  const { packedSamples, ...rest } = row;
  return { ...rest, samples: unpackSamples(packedSamples) };
}

// -------------------------------------------------------------- public API --

export interface ListSessionsQuery {
  /** Only sessions started at or after this timestamp (ms). */
  since?: number;
  scenarioId?: string;
  limit?: number;
}

export interface SensProfile {
  id: string;
  name: string;
  sens: SensConfig;
  createdAt: number;
}

export interface AimTrainerDB {
  /** False when running on the in-memory fallback — the UI should warn that data won't survive a reload. */
  readonly isPersistent: boolean;
  saveSession(session: SessionRecord): Promise<void>;
  getSession(id: string): Promise<SessionRecord | undefined>;
  listSessions(query?: ListSessionsQuery): Promise<SessionRecord[]>;
  deleteSession(id: string): Promise<void>;
  clearAll(): Promise<void>;
  getSetting<T>(key: string): Promise<T | undefined>;
  setSetting<T>(key: string, value: T): Promise<void>;
  saveProfile(profile: SensProfile): Promise<void>;
  listProfiles(): Promise<SensProfile[]>;
  deleteProfile(id: string): Promise<void>;
}

const DB_NAME = 'valorant-aim-trainer';
const DB_VERSION = 1;
const STORE_SESSIONS = 'sessions';
const STORE_SETTINGS = 'settings';
const STORE_PROFILES = 'profiles';

function matchesQuery(session: SessionRecord, query?: ListSessionsQuery): boolean {
  if (!query) return true;
  if (query.since !== undefined && session.startedAt < query.since) return false;
  if (query.scenarioId !== undefined && session.scenarioId !== query.scenarioId) return false;
  return true;
}

function applyLimit<T>(items: T[], limit?: number): T[] {
  return limit !== undefined ? items.slice(0, limit) : items;
}

// ----------------------------------------------------------- memory store --

/**
 * In-memory fallback used whenever IndexedDB itself is unavailable. Sessions
 * still go through pack/unpack so behaviour (including payload shape and
 * float32 precision loss on samples) matches the real backend exactly —
 * tests exercising this store are exercising the real serialisation path.
 */
class MemoryStore implements AimTrainerDB {
  readonly isPersistent = false;
  private sessions = new Map<string, StoredSession>();
  private settings = new Map<string, unknown>();
  private profiles = new Map<string, SensProfile>();

  async saveSession(session: SessionRecord): Promise<void> {
    this.sessions.set(session.id, toStored(session));
  }

  async getSession(id: string): Promise<SessionRecord | undefined> {
    const row = this.sessions.get(id);
    return row ? fromStored(row) : undefined;
  }

  async listSessions(query?: ListSessionsQuery): Promise<SessionRecord[]> {
    const all = [...this.sessions.values()].map(fromStored).filter((s) => matchesQuery(s, query));
    all.sort((a, b) => b.startedAt - a.startedAt);
    return applyLimit(all, query?.limit);
  }

  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async clearAll(): Promise<void> {
    this.sessions.clear();
    this.settings.clear();
    this.profiles.clear();
  }

  async getSetting<T>(key: string): Promise<T | undefined> {
    return this.settings.get(key) as T | undefined;
  }

  async setSetting<T>(key: string, value: T): Promise<void> {
    this.settings.set(key, value);
  }

  async saveProfile(profile: SensProfile): Promise<void> {
    this.profiles.set(profile.id, profile);
  }

  async listProfiles(): Promise<SensProfile[]> {
    return [...this.profiles.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  async deleteProfile(id: string): Promise<void> {
    this.profiles.delete(id);
  }
}

// --------------------------------------------------------- indexeddb store --

function promisifyRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function isQuotaError(err: unknown): boolean {
  return err instanceof DOMException && (err.name === 'QuotaExceededError' || err.code === 22);
}

class IndexedDbStore implements AimTrainerDB {
  readonly isPersistent = true;

  constructor(private db: IDBDatabase) {}

  private tx(store: string, mode: IDBTransactionMode): IDBObjectStore {
    return this.db.transaction(store, mode).objectStore(store);
  }

  async saveSession(session: SessionRecord): Promise<void> {
    try {
      await promisifyRequest(this.tx(STORE_SESSIONS, 'readwrite').put(toStored(session)));
    } catch (err) {
      if (isQuotaError(err)) throw new StorageQuotaError(err);
      throw err;
    }
  }

  async getSession(id: string): Promise<SessionRecord | undefined> {
    const row = await promisifyRequest<StoredSession | undefined>(this.tx(STORE_SESSIONS, 'readonly').get(id));
    return row ? fromStored(row) : undefined;
  }

  async listSessions(query?: ListSessionsQuery): Promise<SessionRecord[]> {
    const store = this.tx(STORE_SESSIONS, 'readonly');
    const rows = await promisifyRequest<StoredSession[]>(store.getAll());
    const all = rows.map(fromStored).filter((s) => matchesQuery(s, query));
    all.sort((a, b) => b.startedAt - a.startedAt);
    return applyLimit(all, query?.limit);
  }

  async deleteSession(id: string): Promise<void> {
    await promisifyRequest(this.tx(STORE_SESSIONS, 'readwrite').delete(id));
  }

  async clearAll(): Promise<void> {
    await Promise.all([
      promisifyRequest(this.tx(STORE_SESSIONS, 'readwrite').clear()),
      promisifyRequest(this.tx(STORE_SETTINGS, 'readwrite').clear()),
      promisifyRequest(this.tx(STORE_PROFILES, 'readwrite').clear()),
    ]);
  }

  async getSetting<T>(key: string): Promise<T | undefined> {
    const row = await promisifyRequest<{ key: string; value: T } | undefined>(this.tx(STORE_SETTINGS, 'readonly').get(key));
    return row?.value;
  }

  async setSetting<T>(key: string, value: T): Promise<void> {
    try {
      await promisifyRequest(this.tx(STORE_SETTINGS, 'readwrite').put({ key, value }));
    } catch (err) {
      if (isQuotaError(err)) throw new StorageQuotaError(err);
      throw err;
    }
  }

  async saveProfile(profile: SensProfile): Promise<void> {
    try {
      await promisifyRequest(this.tx(STORE_PROFILES, 'readwrite').put(profile));
    } catch (err) {
      if (isQuotaError(err)) throw new StorageQuotaError(err);
      throw err;
    }
  }

  async deleteProfile(id: string): Promise<void> {
    await promisifyRequest(this.tx(STORE_PROFILES, 'readwrite').delete(id));
  }

  async listProfiles(): Promise<SensProfile[]> {
    const rows = await promisifyRequest<SensProfile[]>(this.tx(STORE_PROFILES, 'readonly').getAll());
    return rows.sort((a, b) => b.createdAt - a.createdAt);
  }
}

function openIndexedDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        const store = db.createObjectStore(STORE_SESSIONS, { keyPath: 'id' });
        store.createIndex('startedAt', 'startedAt');
        store.createIndex('scenarioId', 'scenarioId');
        store.createIndex('sensitivity', 'sens.sensitivity');
        store.createIndex('eDPI', 'eDPI');
      }
      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_PROFILES)) {
        db.createObjectStore(STORE_PROFILES, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new StorageUnavailableError('IndexedDB upgrade blocked by another open tab.'));
  });
}

/**
 * Opens (or falls back from) the trainer's database. Always resolves — it
 * never throws, because "storage doesn't work" must not be a reason the app
 * fails to start; it should just run un-persisted with `isPersistent: false`.
 */
export async function createDb(): Promise<AimTrainerDB> {
  if (typeof indexedDB === 'undefined') {
    return new MemoryStore();
  }
  try {
    const db = await openIndexedDb();
    return new IndexedDbStore(db);
  } catch {
    // Covers private-browsing rejection, corrupted DB, blocked upgrades, etc.
    return new MemoryStore();
  }
}
