import type { ImagesClient, ImagesJob } from "./types";

const ACTIVE_STATES = new Set(["queued", "running"]);

export function isActiveJob(job: ImagesJob): boolean {
  return ACTIVE_STATES.has(job.state);
}

export interface ImagesJobsSnapshot {
  jobs: ImagesJob[];
  /** The last list request failed; jobs keep their last known state. */
  error?: string;
  loaded: boolean;
}

export interface ImagesJobsWatcher {
  getSnapshot: () => ImagesJobsSnapshot;
  subscribe: (listener: () => void) => () => void;
  /** Lists the jobs now, and keeps polling while any job has not ended. */
  refresh: () => Promise<void>;
  /** Starts a job and follows it until it ends. */
  start: (...args: Parameters<ImagesClient["startJob"]>) => Promise<ImagesJob>;
  cancel: (id: string) => Promise<void>;
  dispose: () => void;
}

interface WatcherOptions {
  intervalMs?: number;
  /** A job ended while watched: the host reloads what it may have changed (Node Templates). */
  onJobEnded?: (job: ImagesJob) => void;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

/**
 * Server-side jobs of one endpoint. Jobs live on the app server, so a reload shows
 * them again; this polls while any of them runs, also when the Images view is closed,
 * and stops once all have ended.
 */
export function createImagesJobsWatcher(
  client: Pick<ImagesClient, "jobs" | "startJob" | "cancelJob">,
  options: WatcherOptions = {}
): ImagesJobsWatcher {
  const intervalMs = options.intervalMs ?? 2000;
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const listeners = new Set<() => void>();
  let snapshot: ImagesJobsSnapshot = { jobs: [], loaded: false };
  let timer: unknown;
  let disposed = false;
  let inFlight: Promise<void> | undefined;

  const emit = (next: ImagesJobsSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const schedule = () => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    if (disposed || !snapshot.jobs.some(isActiveJob)) return;
    timer = setTimer(() => {
      timer = undefined;
      void refresh();
    }, intervalMs);
  };

  const merge = (jobs: ImagesJob[]) => {
    const previous = new Map(snapshot.jobs.map((job) => [job.id, job]));
    for (const job of jobs) {
      const before = previous.get(job.id);
      if (before && isActiveJob(before) && !isActiveJob(job)) options.onJobEnded?.(job);
    }
    const sorted = [...jobs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    emit({ jobs: sorted, loaded: true });
  };

  function refresh(): Promise<void> {
    if (disposed) return Promise.resolve();
    inFlight ??= client
      .jobs()
      .then((response) => merge(response.jobs))
      .catch((error: unknown) => emit({ ...snapshot, loaded: true, error: error instanceof Error ? error.message : String(error) }))
      .finally(() => {
        inFlight = undefined;
        schedule();
      });
    return inFlight;
  }

  const upsert = (job: ImagesJob) => {
    const others = snapshot.jobs.filter((entry) => entry.id !== job.id);
    emit({ ...snapshot, jobs: [job, ...others].sort((a, b) => b.startedAt.localeCompare(a.startedAt)) });
    schedule();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    async start(request) {
      const job = await client.startJob(request);
      upsert(job);
      return job;
    },
    async cancel(id) {
      upsert(await client.cancelJob(id));
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      listeners.clear();
    }
  };
}
