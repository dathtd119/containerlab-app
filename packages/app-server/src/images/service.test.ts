import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import type { ImagesJob } from "@srl-labs/containerlab-lab-backend";

import { RequestError } from "../runtimeProxy.ts";
import { ImagesError } from "./errors.ts";
import { ImagesService } from "./service.ts";
import { createHarness, FAKE_CLIMG } from "./testHarness.ts";
import { createAtomicFileWriter } from "./mutex.ts";

async function untilEnded(harness: Awaited<ReturnType<typeof createHarness>>, id: string): Promise<ImagesJob> {
  for (let i = 0; i < 300; i += 1) {
    const job = await harness.service.jobs.get(id);
    if (job.state !== "running" && job.state !== "queued") return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("job did not end");
}

test("startup needs contract 1 and parses climg config", async (t) => {
  const harness = await createHarness(t);
  assert.equal(harness.service.config.contract, 1);
  assert.deepEqual(harness.service.config.imagesDirs, [harness.imagesDir]);
  const calls = await harness.calls();
  assert.deepEqual(calls[0].argv, ["--version"]);
  assert.deepEqual(calls[1].argv, ["config", "--json"]);

  await assert.rejects(
    createHarness(t, { env: { FAKE_CLIMG_VERSION: "climg 9.0.0 (contract 2)" } }),
    (error: unknown) => error instanceof ImagesError && error.code === "incompatible"
  );
});

test("climg runs with a minimal explicit environment", async (t) => {
  process.env.SOME_SERVER_SECRET = "must-not-leak";
  t.after(() => delete process.env.SOME_SERVER_SECRET);
  const harness = await createHarness(t);
  await harness.service.search({ q: "vios" });
  const call = (await harness.calls()).at(-1)!;
  assert.ok(!call.env.includes("SOME_SERVER_SECRET"));
  for (const name of call.env) {
    assert.ok(
      ["PATH", "HOME", "CLIMG_CONFIG", "CLIMG_STATE", "PYTHONUNBUFFERED"].includes(name) ||
        name.startsWith("FAKE_") || name.toLowerCase().endsWith("_proxy"),
      `unexpected variable ${name}`
    );
  }
  assert.ok(call.env.includes("CLIMG_CONFIG") && call.env.includes("CLIMG_STATE"));
});

test("injection attempts are rejected and no process is started", async (t) => {
  const harness = await createHarness(t);
  const before = (await harness.calls()).length;
  const attempts: Array<() => Promise<unknown>> = [
    () => harness.service.show("--force"),
    () => harness.service.show("vios; rm -rf /"),
    () => harness.service.search({ q: "-x" }),
    () => harness.service.addTemplate("--tag=x"),
    () => harness.service.removeTemplate("-x"),
    () => harness.service.jobs.start({ op: "pull", ref: "--force" }),
    () => harness.service.jobs.start({ op: "pull", ref: "vios; rm -rf /" }),
    () => harness.service.jobs.start({ op: "pull", ref: "labhub:x", tag: "-x" }),
    () => harness.service.jobs.start({ op: "build", file: "../etc/passwd" }),
    () => harness.service.jobs.start({ op: "build", file: "-x" }),
    () => harness.service.jobs.start({ op: "add", file: "a/b.qcow2" }),
    () => harness.service.jobs.start({ op: "rm" as "pull", ref: "x" }),
    () => harness.service.jobs.start({ op: "build", ref: "labhub:x", file: "a.qcow2" })
  ];
  for (const attempt of attempts) {
    await assert.rejects(attempt, (error: unknown) => error instanceof RequestError && error.statusCode === 400);
  }
  assert.equal((await harness.calls()).length, before, "no climg process was started");
  assert.equal((await harness.service.jobs.list()).jobs.length, 0);
});

test("a build job names a file that exists in the images folder, and a missing file is a 404", async (t) => {
  const harness = await createHarness(t);
  await assert.rejects(
    harness.service.jobs.start({ op: "build", file: "nothing.qcow2" }),
    (error: unknown) => error instanceof ImagesError && error.status === 404
  );
  await fs.symlink("/etc/passwd", path.join(harness.imagesDir, "link.qcow2"));
  await assert.rejects(harness.service.jobs.start({ op: "build", file: "link.qcow2" }), RequestError);
});

test("read routes return shape-checked data and redact the credential", async (t) => {
  const harness = await createHarness(t, { password: "s3cretpw" });
  const shown = await harness.service.show("labhub:vios-1");
  assert.ok(!JSON.stringify(shown).includes("s3cretpw"));
  assert.match(JSON.stringify(shown), /<redacted>/);
  const status = await harness.service.status();
  assert.ok(!JSON.stringify(status).includes("s3cretpw"));
  assert.equal(status.contract, 1);
  assert.equal(status.doctor.ok, true);
  assert.deepEqual((await harness.service.search({ q: "vios" }))[0].key, "labhub:vios-1");
  assert.equal((await harness.service.index(false)).release, "R1");
  assert.equal((await harness.service.images())[0].tag, "vrnetlab/cisco_vios:159-3.M3");
  assert.deepEqual(await harness.service.scan(), []);
  await assert.rejects(harness.service.show("labhub:nope"), (error: unknown) => error instanceof ImagesError && error.status === 404 && error.code === "not_found");
});

test("doctor is cached for five minutes and a failing check is reported", async (t) => {
  const harness = await createHarness(t, { env: { FAKE_NO_KVM: "1" } });
  const first = await harness.service.status();
  assert.equal(first.doctor.ok, false);
  assert.equal(first.doctor.checks.find((check) => check.check === "/dev/kvm")?.status, "FAIL");
  await harness.service.status();
  const doctors = (await harness.calls()).filter((call) => call.argv[0] === "doctor");
  assert.equal(doctors.length, 1);
});

test("a malformed climg answer is reported as incompatible", async (t) => {
  const harness = await createHarness(t);
  const original = harness.service.client.json.bind(harness.service.client);
  harness.service.client.json = async () => ({ not: "an array" });
  await assert.rejects(harness.service.search({}), (error: unknown) => error instanceof ImagesError && error.code === "incompatible");
  harness.service.client.json = original;
});

test("job lifecycle: success writes the template under the lock and redacts the log", async (t) => {
  const harness = await createHarness(t, { password: "s3cretpw" });
  const started = await harness.service.jobs.start({ op: "pull", ref: "labhub:vios-1" });
  assert.equal(started.state, "running");
  const ended = await untilEnded(harness, started.id);
  const calls = await harness.calls();
  const pull = calls.find((call) => call.argv[0] === "pull")!;
  assert.deepEqual(pull.argv.slice(0, 6), ["pull", "--yes", "--json", "--job-file", path.join(harness.stateDir, "jobs", `${started.id}.json`), "--no-nodetpl"]);
  assert.deepEqual(pull.argv.slice(-2), ["--", "labhub:vios-1"]);

  assert.equal(ended.state, "succeeded");
  assert.equal(ended.pct, 100);
  assert.ok(ended.nodetpl?.written, JSON.stringify(ended.nodetpl));
  assert.ok(!JSON.stringify(ended).includes("s3cretpw"));
  const stored = JSON.parse(await fs.readFile(harness.nodetplFile, "utf8")) as Array<{ name: string }>;
  assert.ok(stored.some((entry) => entry.name === ended.nodetpl?.name));
  const nodetpl = (await harness.calls()).find((call) => call.argv[0] === "nodetpl" && call.argv.includes("add"))!;
  assert.deepEqual(nodetpl.argv.slice(0, 7), ["nodetpl", "--json", "--writer", "file", "--nodetpl-file", harness.nodetplFile, "--"]);
  for (const name of [".json", ".out", ".err", ".meta.json"]) {
    await fs.access(path.join(harness.stateDir, "jobs", `${started.id}${name}`));
  }
  const listed = await harness.service.jobs.list();
  assert.equal(listed.active, 0);
  assert.equal(listed.jobs[0].id, started.id);
});

test("job lifecycle: failure keeps the error and other jobs go on", async (t) => {
  const harness = await createHarness(t, { password: "s3cretpw" });
  const bad = await harness.service.jobs.start({ op: "pull", ref: "labhub:fail" });
  const good = await harness.service.jobs.start({ op: "pull", ref: "labhub:ok" });
  const failed = await untilEnded(harness, bad.id);
  assert.equal(failed.state, "failed");
  assert.match(failed.error ?? "", /build failed/);
  assert.ok(!JSON.stringify(failed).includes("s3cretpw"));
  assert.equal((await untilEnded(harness, good.id)).state, "succeeded");
});

test("job lifecycle: cancel sends SIGTERM and the job ends as cancelled", async (t) => {
  const harness = await createHarness(t, { env: { FAKE_CLIMG_JOB_MS: "20000" } });
  const started = await harness.service.jobs.start({ op: "pull", ref: "labhub:slow" });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const cancelling = await harness.service.jobs.cancel(started.id);
  assert.equal(cancelling.cancelRequested, true);
  const ended = await untilEnded(harness, started.id);
  assert.equal(ended.state, "cancelled");
  assert.equal(ended.exitCode, 4);
  await assert.rejects(harness.service.jobs.cancel(started.id), (error: unknown) => error instanceof ImagesError && error.status === 409);
  // The same image can be started again right after a cancel.
  const again = await harness.service.jobs.start({ op: "pull", ref: "labhub:slow" });
  await harness.service.jobs.cancel(again.id);
  assert.equal((await untilEnded(harness, again.id)).state, "cancelled");
});

test("job lifecycle: a child that ignores SIGTERM gets SIGKILL for its group after the grace period", async (t) => {
  const harness = await createHarness(t, { env: { FAKE_CLIMG_JOB_MS: "60000", FAKE_CLIMG_IGNORE_TERM: "1" } });
  // A short grace period for the test; production uses 30 s.
  const { JobRegistry } = await import("./jobs.ts");
  const jobs = new JobRegistry({
    config: harness.config,
    client: harness.service.client,
    redactor: harness.service.redactor,
    mutex: harness.mutex,
    jobsDir: path.join(harness.stateDir, "jobs"),
    imagesDir: harness.imagesDir,
    nodetplFile: harness.nodetplFile,
    killAfterMs: 400
  });
  const started = await jobs.start({ op: "pull", ref: "labhub:stuck" });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await jobs.cancel(started.id);
  const began = Date.now();
  await jobs.idle(8000);
  assert.ok(Date.now() - began >= 250, "killed after the grace period, not at once");
  const ended = await jobs.get(started.id);
  assert.equal(ended.state, "cancelled");
  assert.equal(ended.exitCode, null);
});

test("the number of running jobs is capped", async (t) => {
  const harness = await createHarness(t, { env: { FAKE_CLIMG_JOB_MS: "20000" }, config: { maxJobs: 2 } });
  const first = await harness.service.jobs.start({ op: "pull", ref: "labhub:a" });
  const second = await harness.service.jobs.start({ op: "pull", ref: "labhub:b" });
  await assert.rejects(
    harness.service.jobs.start({ op: "pull", ref: "labhub:c" }),
    (error: unknown) => error instanceof ImagesError && error.status === 429
  );
  await harness.service.jobs.cancel(first.id);
  await harness.service.jobs.cancel(second.id);
});

test("restart recovery: unfinished jobs are failed 'server restarted' and nothing is signalled", async (t) => {
  const harness = await createHarness(t);
  const jobsDir = path.join(harness.stateDir, "jobs");
  await fs.mkdir(jobsDir, { recursive: true });
  // A sleeping process stands in for "another host process" that now has the stored pid.
  const { spawn } = await import("node:child_process");
  const bystander = spawn("sleep", ["30"], { stdio: "ignore" });
  t.after(() => bystander.kill());
  const id = "11111111-1111-1111-1111-111111111111";
  const stored: ImagesJob = {
    id, op: "pull", ref: "labhub:x", state: "running", phase: "build", pct: 40, message: "x", log: [],
    startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
  };
  await fs.writeFile(path.join(jobsDir, `${id}.meta.json`), JSON.stringify({ ...stored, pid: bystander.pid }));

  const signals: string[] = [];
  const realKill = process.kill;
  process.kill = ((pid: number, signal?: string | number) => {
    if (signal !== 0) signals.push(`${pid}:${String(signal)}`);
    return realKill.call(process, pid, signal as NodeJS.Signals);
  }) as typeof process.kill;
  t.after(() => { process.kill = realKill; });

  const restarted = await ImagesService.create({
    config: harness.config, store: harness.store, mutex: harness.mutex, nodetplFile: harness.nodetplFile
  });
  const job = await restarted.jobs.get(id);
  assert.equal(job.state, "failed");
  assert.equal(job.error, "server restarted");
  assert.equal((await restarted.jobs.list()).active, 0);
  await assert.rejects(restarted.jobs.cancel(id), (error: unknown) => error instanceof ImagesError && error.status === 409);
  assert.deepEqual(signals, [], "no signal was sent");
  assert.equal(bystander.exitCode, null);
  const rewritten = JSON.parse(await fs.readFile(path.join(jobsDir, `${id}.meta.json`), "utf8")) as ImagesJob;
  assert.equal(rewritten.state, "failed");
});

test("Node Template writes: a palette save and a job template write interleave without losing either", async (t) => {
  const harness = await createHarness(t, { env: { FAKE_CLIMG_NODETPL_PAUSE_MS: "300" } });
  await harness.store.replaceCustomNodes([{ name: "base", kind: "linux" }]);
  const started = await harness.service.jobs.start({ op: "pull", ref: "labhub:vios-1" });
  // The job's template step reads, pauses 300 ms, then writes; the palette save lands in that window.
  const waitForStep = async () => {
    for (let i = 0; i < 200; i += 1) {
      if ((await harness.calls()).some((call) => call.argv[0] === "nodetpl" && call.argv.includes("add"))) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("template step never started");
  };
  await waitForStep();
  const saving = harness.store.saveCustomNode({ name: "palette", kind: "linux", image: "alpine" });
  const ended = await untilEnded(harness, started.id);
  await saving;
  assert.equal(ended.state, "succeeded");
  const names = (JSON.parse(await fs.readFile(harness.nodetplFile, "utf8")) as Array<{ name: string }>).map((entry) => entry.name);
  assert.ok(names.includes("base") && names.includes("palette") && names.some((name) => name.startsWith("tpl-")), `got ${names.join(",")}`);
});

test("without the lock the same interleaving loses a write (the lock is what prevents it)", async (t) => {
  const harness = await createHarness(t, { env: { FAKE_CLIMG_NODETPL_PAUSE_MS: "300" } });
  await harness.store.replaceCustomNodes([{ name: "base", kind: "linux" }]);
  const { createLocalUiStore } = await import("../localUiStore.ts");
  const unlocked = createLocalUiStore({ clabDirectory: harness.workspace, workspaceRoot: harness.workspace });
  const step = harness.service.client.json(["nodetpl", "--json", "--writer", "file", "--nodetpl-file", harness.nodetplFile, "--", "add", "x:1"]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await unlocked.saveCustomNode({ name: "palette", kind: "linux" });
  await step;
  const names = (JSON.parse(await fs.readFile(harness.nodetplFile, "utf8")) as Array<{ name: string }>).map((entry) => entry.name);
  assert.ok(!names.includes("palette"), "the unlocked write was overwritten");
});

test("the store file is written atomically at mode 0660 and stays valid JSON while saves race", async (t) => {
  const harness = await createHarness(t);
  await harness.store.replaceCustomNodes([{ name: "a", kind: "linux" }]);
  const stat = await fs.stat(harness.nodetplFile);
  assert.equal(stat.mode & 0o777, 0o660);
  let stop = false;
  const reader = (async () => {
    while (!stop) {
      JSON.parse(await fs.readFile(harness.nodetplFile, "utf8"));
    }
  })();
  await Promise.all(Array.from({ length: 30 }, (_, i) => harness.store.saveCustomNode({ name: `n${i}`, kind: "linux" })));
  stop = true;
  await reader;
  const names = (await harness.store.getCustomNodes()).customNodes.map((node) => node.name);
  assert.equal(new Set(names).size, 31);
  assert.deepEqual((await fs.readdir(path.dirname(harness.nodetplFile))).filter((name) => name.endsWith(".tmp")), []);
  // A different process (a non-root climg run-as user) only needs the mode; check the group/other bits of the file and its folder.
  assert.equal((await fs.stat(path.dirname(harness.nodetplFile))).mode & 0o070, 0o070);
  void createAtomicFileWriter;
});

test("templates: list joins climg's managed flag with the store; remove is for managed templates only", async (t) => {
  const harness = await createHarness(t);
  await harness.store.replaceCustomNodes([{ name: "foreign", kind: "linux", image: "alpine:3" }]);
  await harness.service.addTemplate("vrnetlab/cisco_vios:159-3.M3");
  const { templates } = await harness.service.templates();
  const managed = templates.find((template) => template.managed)!;
  assert.ok(managed);
  assert.equal(managed.imagePresent, true);
  const foreign = templates.find((template) => template.name === "foreign")!;
  assert.equal(foreign.managed, false);
  assert.equal(foreign.imagePresent, null);
  await assert.rejects(harness.service.removeTemplate("foreign"), (error: unknown) => error instanceof ImagesError && error.status === 403);
  await assert.rejects(harness.service.removeTemplate("ghost"), (error: unknown) => error instanceof ImagesError && error.status === 404);
  const removed = await harness.service.removeTemplate(managed.name);
  assert.deepEqual(removed.removed, [managed.name]);
  assert.ok(!(await harness.store.getCustomNodes()).customNodes.some((node) => node.name === managed.name));
});

test("templates: customized comes from climg and is absent for an older climg", async (t) => {
  const harness = await createHarness(t);
  await harness.service.addTemplate("vrnetlab/cisco_vios:159-3.M3");
  const plain = (await harness.service.templates()).templates.find((template) => template.managed)!;
  assert.equal(plain.customized, false);

  const edited = await createHarness(t);
  await edited.service.addTemplate("vrnetlab/cisco_vios:159-3.M3");
  const name = (await edited.service.templates()).templates[0].name;
  const custom = await createHarness(t, { env: { FAKE_CLIMG_CUSTOMIZED: name } });
  await custom.store.replaceCustomNodes((await edited.store.getCustomNodes()).customNodes);
  await fs.writeFile(`${custom.nodetplFile}.owned.json`, JSON.stringify([name]));
  assert.equal((await custom.service.templates()).templates[0].customized, true);

  const legacy = await createHarness(t, { env: { FAKE_CLIMG_LEGACY: "1" } });
  await legacy.service.addTemplate("vrnetlab/cisco_vios:159-3.M3");
  const row = (await legacy.service.templates()).templates.find((template) => template.managed)!;
  assert.equal("customized" in row, false);
});

test("template sync passes kept fields and skipped entries through, and tolerates their absence", async (t) => {
  const harness = await createHarness(t, {
    env: { FAKE_CLIMG_SYNC_KEPT: "tpl-a:interfacePattern,icon", FAKE_CLIMG_SYNC_SKIPPED: "tpl-b" }
  });
  const preview = await harness.service.syncTemplates(true);
  assert.deepEqual(preview.changes, [{ action: "updated", name: "tpl-a", kept: ["interfacePattern", "icon"] }]);
  assert.deepEqual(preview.skipped, [{ name: "tpl-b", reason: "edited by user; image missing" }]);

  const legacy = await createHarness(t, { env: { FAKE_CLIMG_SYNC_KEPT: "tpl-a:icon", FAKE_CLIMG_LEGACY: "1" } });
  assert.deepEqual((await legacy.service.syncTemplates(true)).changes, [{ action: "updated", name: "tpl-a" }]);
});

test("a job result carries the kept fields of an updated template, and none for an older climg", async (t) => {
  const kept = await createHarness(t, { env: { FAKE_CLIMG_KEPT: "interfacePattern" } });
  const started = await kept.service.jobs.start({ op: "pull", ref: "labhub:vios-1" });
  const ended = await untilEnded(kept, started.id);
  assert.deepEqual(ended.nodetpl?.kept, ["interfacePattern"]);

  const fromResult = await createHarness(t, { env: { FAKE_CLIMG_JOB_KEPT: "icon" } });
  const second = await untilEnded(fromResult, (await fromResult.service.jobs.start({ op: "pull", ref: "labhub:vios-1" })).id);
  assert.deepEqual(second.nodetpl?.kept, ["icon"]);

  const legacy = await createHarness(t, { env: { FAKE_CLIMG_KEPT: "interfacePattern", FAKE_CLIMG_LEGACY: "1" } });
  const third = await untilEnded(legacy, (await legacy.service.jobs.start({ op: "pull", ref: "labhub:vios-1" })).id);
  assert.equal(third.state, "succeeded");
  assert.equal(third.nodetpl !== undefined && "kept" in third.nodetpl, false);

  const plain = await createHarness(t);
  const fourth = await untilEnded(plain, (await plain.service.jobs.start({ op: "pull", ref: "labhub:vios-1" })).id);
  assert.equal(fourth.nodetpl !== undefined && "kept" in fourth.nodetpl, false);
});

test("template sync with dry-run changes nothing", async (t) => {
  const harness = await createHarness(t);
  const preview = await harness.service.syncTemplates(true);
  assert.equal(preview.dry_run, true);
  const call = (await harness.calls()).at(-1)!;
  assert.ok(call.argv.includes("--dry-run"));
  assert.deepEqual(call.argv.slice(-2), ["--", "sync"]);
  await assert.rejects(fs.access(harness.nodetplFile));
});

test("the fake climg path is the only executable run", async (t) => {
  const harness = await createHarness(t);
  assert.equal(harness.config.climgPath, FAKE_CLIMG);
});
