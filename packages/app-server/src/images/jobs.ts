import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import type { ImagesJob, ImagesJobRequest, ImagesJobsResponse } from "@srl-labs/containerlab-lab-backend";

import { RequestError } from "../runtimeProxy.ts";
import { jobArgs, nodetplArgs } from "./args.ts";
import type { ClimgClient } from "./client.ts";
import { tail } from "./client.ts";
import type { ImagesConfig } from "./config.ts";
import { ImagesError } from "./errors.ts";
import type { AsyncMutex } from "./mutex.ts";
import { chownToRunAs, mkdirForRunAs } from "./ownership.ts";
import type { Redactor } from "./redact.ts";
import { openOutputFile, signalGroup, spawnClimg } from "./runner.ts";
import { isObjectValue, keptFields, keptList, parseJobDoc, parseTemplateResult } from "./shapes.ts";
import { validateEnum, validateFileName, validateJobId, validateRef } from "./validate.ts";

const JOB_OPS = ["pull", "build", "add"] as const;
const DIR_MODE = 0o770;
const FILE_MODE = 0o660;
const KILL_AFTER_MS = 30_000;
const LISTED_JOBS = 50;
const OPEN_STATES = new Set(["queued", "running"]);
const LOG_LINES = 40;
const ERR_TAIL = 2000;

interface LiveJob {
  job: ImagesJob;
  pid: number | undefined;
  /** The child has exited and been reaped: its pid may belong to another process now, so no signal is sent. */
  reaped: boolean;
  exited: boolean;
  killTimer?: NodeJS.Timeout;
}

export interface JobRegistryOptions {
  config: ImagesConfig;
  client: ClimgClient;
  redactor: Redactor;
  mutex: AsyncMutex;
  /** `<climg state>/jobs`. */
  jobsDir: string;
  /** The first images folder: files named by a job live here. */
  imagesDir: string;
  /** The file the app serves its Node Templates from. */
  nodetplFile: string;
  /** SIGKILL to the group this long after SIGTERM. */
  killAfterMs?: number;
  log?: (message: string) => void;
}

/**
 * Jobs this server instance started. Job files of earlier instances are only
 * read: an unfinished one is shown as failed ("server restarted") and no signal
 * is ever sent for it, because a stored pid may belong to another process now.
 */
export class JobRegistry {
  private readonly live = new Map<string, LiveJob>();
  private readonly killAfterMs: number;
  /** Slots taken by `start()` calls that passed the cap check but have not registered their job yet. */
  private pending = 0;

  constructor(private readonly options: JobRegistryOptions) {
    this.killAfterMs = options.killAfterMs ?? KILL_AFTER_MS;
  }

  private path(id: string, extension: string): string {
    return path.join(this.options.jobsDir, `${id}${extension}`);
  }

  get activeCount(): number {
    let count = this.pending;
    for (const entry of this.live.values()) if (!entry.exited) count += 1;
    return count;
  }

  /** Marks jobs left unfinished by an earlier instance as failed. Reads and rewrites job files only. */
  async recover(): Promise<void> {
    for (const job of await this.readStored()) {
      if (!OPEN_STATES.has(job.state)) continue;
      const failed = this.markRestarted(job);
      await this.persist(failed).catch(() => undefined);
    }
  }

  private markRestarted(job: ImagesJob): ImagesJob {
    const now = new Date().toISOString();
    return { ...job, state: "failed", error: "server restarted", message: "server restarted", finishedAt: now, updatedAt: now };
  }

  private async readStored(): Promise<ImagesJob[]> {
    let names: string[];
    try {
      names = await fsp.readdir(this.options.jobsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const jobs: ImagesJob[] = [];
    for (const name of names) {
      const match = /^([A-Za-z0-9-]+)\.meta\.json$/.exec(name);
      if (!match || this.live.has(match[1])) continue;
      try {
        const parsed: unknown = JSON.parse(await fsp.readFile(path.join(this.options.jobsDir, name), "utf8"));
        if (isObjectValue(parsed) && typeof parsed.id === "string" && typeof parsed.state === "string") {
          jobs.push(parsed as unknown as ImagesJob);
        }
      } catch {
        // A job file that does not parse is skipped.
      }
    }
    return jobs;
  }

  private async persist(job: ImagesJob): Promise<void> {
    const file = this.path(job.id, ".meta.json");
    const temp = `${file}.${randomUUID()}.tmp`;
    await fsp.writeFile(temp, `${JSON.stringify(job)}\n`, { mode: FILE_MODE });
    try {
      await chownToRunAs(this.options.config.runAs, temp);
      await fsp.rename(temp, file);
    } catch (error) {
      await fsp.rm(temp, { force: true });
      throw error;
    }
  }

  /** Reads `climg`'s progress file into the job view. */
  private async refresh(live: LiveJob): Promise<ImagesJob> {
    const { job } = live;
    if (live.exited) return job;
    let doc;
    try {
      doc = parseJobDoc(JSON.parse(await fsp.readFile(this.path(job.id, ".json"), "utf8")));
    } catch {
      doc = undefined;
    }
    if (!doc) return job;
    const state = OPEN_STATES.has(doc.state) ? doc.state : "running";
    return {
      ...job,
      state: state as ImagesJob["state"],
      phase: doc.phase,
      pct: doc.pct,
      message: this.options.redactor.text(doc.message),
      log: doc.log.slice(-LOG_LINES).map((line) => this.options.redactor.text(line))
    };
  }

  async list(): Promise<ImagesJobsResponse> {
    const jobs: ImagesJob[] = [];
    for (const live of this.live.values()) jobs.push(await this.refresh(live));
    for (const stored of await this.readStored()) {
      jobs.push(OPEN_STATES.has(stored.state) ? this.markRestarted(stored) : stored);
    }
    jobs.sort((left, right) => (right.startedAt ?? "").localeCompare(left.startedAt ?? ""));
    const shown = jobs.slice(0, LISTED_JOBS);
    return { jobs: shown, active: shown.filter((job) => OPEN_STATES.has(job.state)).length };
  }

  async get(idValue: unknown): Promise<ImagesJob> {
    const id = validateJobId(idValue);
    const live = this.live.get(id);
    if (live) return this.refresh(live);
    const stored = (await this.readStored()).find((job) => job.id === id);
    if (!stored) throw new ImagesError("Job not found", 404, "not_found");
    return OPEN_STATES.has(stored.state) ? this.markRestarted(stored) : stored;
  }

  /** Checks an image file name against the images folder: it must be a plain file there. */
  private async imageFile(value: unknown): Promise<string> {
    const name = validateFileName(value);
    const file = path.join(this.options.imagesDir, name);
    let stat;
    try {
      stat = await fsp.lstat(file);
    } catch {
      throw new ImagesError(`No file ${name} in the images folder`, 404, "not_found");
    }
    if (!stat.isFile()) throw new RequestError(`Invalid file name: ${JSON.stringify(name)}`, 400);
    return file;
  }

  async start(request: ImagesJobRequest): Promise<ImagesJob> {
    const op = validateEnum("op", request?.op, JOB_OPS);
    const body = request as unknown as Record<string, unknown>;
    if (op === "pull" && body.file !== undefined) throw new RequestError("pull takes a ref, not a file", 400);
    if (op === "add" && body.ref !== undefined) throw new RequestError("add takes a file", 400);
    if (op === "pull" && body.ref === undefined) throw new RequestError("Missing ref", 400);
    if (op !== "pull" && body.force !== undefined) throw new RequestError("force applies to pull only", 400);
    if (op === "add" && body.file === undefined) throw new RequestError("Missing file", 400);
    if (op === "build" && (body.file === undefined) === (body.ref === undefined)) {
      throw new RequestError("build takes either ref or file", 400);
    }
    if (body.ref !== undefined) validateRef(body.ref);
    const filePath = body.file !== undefined ? await this.imageFile(body.file) : undefined;

    if (this.activeCount >= this.options.config.maxJobs) {
      throw new ImagesError(`At most ${this.options.config.maxJobs} jobs run at once`, 429, "too_many_jobs");
    }

    // Reserved before the first await, so parallel starts cannot all pass the check above.
    this.pending += 1;
    let reserved = true;
    const release = () => {
      if (reserved) {
        reserved = false;
        this.pending -= 1;
      }
    };
    try {
      const id = randomUUID();
      const jobFile = this.path(id, ".json");
      // Arguments are built (and validated) before anything is created or started.
      const args = jobArgs({
        op,
        ...(body.ref !== undefined ? { ref: body.ref } : {}),
        ...(filePath !== undefined ? { filePath } : {}),
        ...(body.kind !== undefined ? { kind: body.kind } : {}),
        ...(body.version !== undefined ? { version: body.version } : {}),
        ...(body.tag !== undefined ? { tag: body.tag } : {}),
        ...(body.force !== undefined ? { force: body.force } : {}),
        jobFile
      });

      const { runAs } = this.options.config;
      await mkdirForRunAs(runAs, this.options.jobsDir, DIR_MODE);
      const chown = (target: string) => chownToRunAs(runAs, target);
      const out = await openOutputFile(this.path(id, ".out"), chown);
      let err;
      try {
        err = await openOutputFile(this.path(id, ".err"), chown);
      } catch (error) {
        await out.close();
        throw error;
      }

      const now = new Date().toISOString();
      const job: ImagesJob = {
        id,
        op,
        ...(typeof body.ref === "string" ? { ref: body.ref } : {}),
        ...(typeof body.file === "string" ? { file: body.file } : {}),
        ...(typeof body.kind === "string" ? { kind: body.kind } : {}),
        ...(typeof body.version === "string" ? { version: body.version } : {}),
        ...(typeof body.tag === "string" ? { tag: body.tag } : {}),
        ...(body.force === true ? { force: true } : {}),
        state: "running",
        phase: "",
        pct: null,
        message: "",
        log: [],
        startedAt: now,
        updatedAt: now
      };
      const spawned = spawnClimg(this.options.config, args, { stdout: out.fd, stderr: err.fd });
      // The child holds its own copies of the descriptors.
      await Promise.all([out.close(), err.close()]);
      const live: LiveJob = { job, pid: spawned.child.pid, reaped: false, exited: false };
      this.live.set(id, live);
      release();
      await this.persist(job).catch((error: unknown) => this.options.log?.(`job ${id}: cannot write job file: ${String(error)}`));
      void spawned.done.then((exit) => this.finish(live, exit));
      return job;
    } finally {
      release();
    }
  }

  private async finish(
    live: LiveJob,
    exit: { code: number | null; signal: NodeJS.Signals | null; startError?: Error }
  ): Promise<void> {
    // First, before any await: the child is reaped, so Cancel and the SIGKILL timer must not signal its pid.
    live.reaped = true;
    live.pid = undefined;
    const { redactor } = this.options;
    if (live.killTimer) clearTimeout(live.killTimer);
    const id = live.job.id;
    let ended: ImagesJob = { ...live.job };
    try {
      const doc = await fsp
        .readFile(this.path(id, ".json"), "utf8")
        .then((text) => parseJobDoc(JSON.parse(text)))
        .catch(() => undefined);
      const stdout = await fsp.readFile(this.path(id, ".out"), "utf8").catch(() => "");
      const stderr = await fsp.readFile(this.path(id, ".err"), "utf8").catch(() => "");
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        parsed = undefined;
      }
      const errorMessage =
        isObjectValue(parsed) && isObjectValue(parsed.error) && typeof parsed.error.message === "string"
          ? parsed.error.message
          : undefined;

      let state: ImagesJob["state"];
      let error: string | undefined;
      if (exit.startError) {
        state = "failed";
        error = `cannot start climg: ${exit.startError.message}`;
      } else if (live.job.cancelRequested === true && (exit.code === 4 || exit.signal !== null || exit.code !== 0)) {
        state = "cancelled";
      } else if (exit.code === 4) {
        state = "cancelled";
      } else if (exit.code === 0) {
        state = "succeeded";
      } else {
        state = "failed";
        error = errorMessage ?? (doc?.message || tail(stderr, ERR_TAIL) || `climg exited with ${exit.signal ?? exit.code}`);
      }
      const result = isObjectValue(parsed) && !isObjectValue(parsed.error) ? parsed : doc?.result;
      const logLines = doc?.log.length ? doc.log : stderr.split("\n").filter(Boolean).slice(-LOG_LINES);
      ended = {
        ...live.job,
        state,
        phase: state === "succeeded" ? "done" : (doc?.phase ?? live.job.phase),
        pct: state === "succeeded" ? 100 : (doc?.pct ?? null),
        message: redactor.text(doc?.message || (state === "failed" ? (error ?? "") : state)),
        log: logLines.slice(-LOG_LINES).map((line) => redactor.text(line)),
        ...(result !== undefined ? { result: redactor.deep(result) } : {}),
        ...(error !== undefined ? { error: redactor.text(error) } : {}),
        exitCode: exit.code,
        updatedAt: new Date().toISOString()
      };
      if (state === "succeeded") ended = await this.writeTemplate(ended);
    } catch (error) {
      ended = { ...ended, state: "failed", error: redactor.text(error instanceof Error ? error.message : String(error)) };
    }
    const now = new Date().toISOString();
    live.job = { ...ended, finishedAt: now, updatedAt: now };
    live.exited = true;
    await this.persist(live.job).catch((error: unknown) => this.options.log?.(`job ${id}: cannot write job file: ${String(error)}`));
  }

  /**
   * The Node Template step of a successful job, under the template lock: `climg`
   * ran with `--no-nodetpl`, so the server writes the template the result names.
   */
  private async writeTemplate(job: ImagesJob): Promise<ImagesJob> {
    const result = isObjectValue(job.result) ? job.result : undefined;
    const template = result && isObjectValue(result.nodetpl) ? result.nodetpl : undefined;
    const name = typeof template?.name === "string" ? template.name : undefined;
    if (!result || !name) return job;
    const target = [result.tag, result.ref].find((candidate) => {
      try {
        validateRef(candidate);
        return true;
      } catch {
        return false;
      }
    });
    if (typeof target !== "string") {
      return { ...job, nodetpl: { name, written: false, error: "no valid reference to write the template for" } };
    }
    try {
      const doc = await this.options.mutex.run(async () =>
        parseTemplateResult(await this.options.client.json(nodetplArgs(this.options.nodetplFile, "add", target)))
      );
      const kept = keptFields(doc.changes) ?? keptList(template?.kept);
      return { ...job, nodetpl: { name, written: doc.changes.length > 0, ...(kept ? { kept } : {}) } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.log?.(`job ${job.id}: node template not written: ${message}`);
      return { ...job, nodetpl: { name, written: false, error: this.options.redactor.text(message) } };
    }
  }

  /** SIGTERM to `climg`, SIGKILL to its group after the grace period. Only for children of this process. */
  async cancel(idValue: unknown): Promise<ImagesJob> {
    const id = validateJobId(idValue);
    const live = this.live.get(id);
    if (!live) {
      const known = (await this.readStored()).some((job) => job.id === id);
      if (!known) throw new ImagesError("Job not found", 404, "not_found");
      throw new ImagesError("This job was not started by this server instance and cannot be cancelled", 409, "not_ours");
    }
    if (live.exited) throw new ImagesError("Job has already ended", 409, "ended");
    if (live.reaped || live.pid === undefined) {
      throw new ImagesError("Job has already exited and is finishing up; nothing to cancel", 409, "finishing");
    }
    if (live.job.cancelRequested !== true) {
      live.job = { ...live.job, cancelRequested: true };
      const { pid } = live;
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Gone already; the exit handler settles the job.
      }
      live.killTimer = setTimeout(() => {
        if (!live.reaped) signalGroup(pid, "SIGKILL");
      }, this.killAfterMs);
      live.killTimer.unref();
    }
    return this.refresh(live);
  }

  /** Waits for every job of this instance to end (tests and shutdown). */
  async idle(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.activeCount > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
