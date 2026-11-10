#!/usr/bin/env node
// A stand-in for `climg` (contract 1) for the Images tests. It records every command line
// and emits contract-1 JSON. Behaviour is steered by FAKE_CLIMG_* variables.
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const env = process.env;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (env.FAKE_CLIMG_LOG) {
  fs.appendFileSync(
    env.FAKE_CLIMG_LOG,
    `${JSON.stringify({ argv, pid: process.pid, env: Object.keys(env).sort(), uid: process.getuid?.(), gid: process.getgid?.() })}\n`
  );
}

const out = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const fail = (code, message, exit = 1) => {
  out({ error: { code, message } });
  process.exit(exit);
};
const PASSWORD = env.FAKE_CLIMG_PASSWORD ?? "";

/** Splits `cmd options -- positionals`; refuses what real climg refuses (no `--`: usage error). */
function parse(args) {
  const dash = args.indexOf("--");
  const head = dash === -1 ? args : args.slice(0, dash);
  const positionals = dash === -1 ? [] : args.slice(dash + 1);
  const options = new Map();
  for (let i = 1; i < head.length; i += 1) {
    const arg = head[i];
    if (!arg.startsWith("--")) {
      process.stderr.write(`usage error: positional before --: ${arg}\n`);
      process.exit(2);
    }
    const flags = new Set(["--json", "--yes", "--force", "--no-nodetpl", "--dry-run", "--refresh", "--all", "--build"]);
    if (flags.has(arg)) options.set(arg, true);
    else options.set(arg, head[++i]);
  }
  return { command: head[0], options, positionals };
}

if (argv[0] === "--version") {
  console.log(env.FAKE_CLIMG_VERSION ?? "climg 0.1.0 (contract 1)");
  process.exit(0);
}

const { command, options, positionals } = parse(argv);
const imagesDir = env.FAKE_IMAGES_DIR ?? "/tmp/fake-images";
const stateDir = env.CLIMG_STATE ?? "/tmp/fake-state";

const RECORD = {
  key: "labhub:vios-1", source: "labhub", status: "available", kind: "cisco_vios", version: "159-3.M3",
  name: "vios-1", size: 1000, tag: "vrnetlab/cisco_vios:159-3.M3", detail: ""
};

function templateEntry(tag) {
  const name = `tpl-${tag.replace(/[^A-Za-z0-9.-]+/g, "-")}`;
  return { name, kind: "cisco_vios", image: tag, icon: "router", baseName: "vios", interfacePattern: "eth{n}", setDefault: false };
}

function nodetplFile() {
  const file = options.get("--nodetpl-file");
  if (!file) fail("no_config", "no --nodetpl-file");
  return file;
}
const ownedFile = (file) => `${file}.owned.json`;
const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
};

async function nodetpl() {
  const [action, target] = positionals;
  const file = nodetplFile();
  const owned = readJson(ownedFile(file), []);
  const current = readJson(file, []);
  const result = (changes, extra = {}) => ({
    action, dry_run: options.has("--dry-run"), writer: "file", changes,
    skipped: [], added: changes.filter((c) => c.action === "created").map((c) => c.name),
    updated: [], removed: changes.filter((c) => c.action === "deleted").map((c) => c.name), ...extra
  });
  // Non-atomic read-modify-write with a pause, like the real file writer under a race.
  const commit = async (next, nextOwned) => {
    await wait(Number(env.FAKE_CLIMG_NODETPL_PAUSE_MS ?? 0));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
    fs.writeFileSync(ownedFile(file), JSON.stringify(nextOwned));
  };
  if (action === "list") {
    return out(current.map((c) => ({ name: c.name, kind: c.kind, image: c.image ?? "-", icon: c.icon ?? "-", owned: owned.includes(c.name) })));
  }
  if (action === "add") {
    const e = templateEntry(target.replace(/^(labhub|local):/, ""));
    if (target === "labhub:missing") fail("not_found", "no such image");
    const changes = current.some((c) => c.name === e.name) ? [] : [{ action: "created", name: e.name }];
    if (changes.length) await commit([...current, e], [...owned, e.name]);
    return out(result(changes, { template: e }));
  }
  if (action === "remove") {
    const changes = current.some((c) => c.name === target) ? [{ action: "deleted", name: target }] : [];
    if (changes.length && !options.has("--dry-run")) await commit(current.filter((c) => c.name !== target), owned.filter((n) => n !== target));
    return out(result(changes));
  }
  if (action === "sync") {
    const stale = owned.filter((n) => !current.some((c) => c.name === n));
    return out(result(stale.map((name) => ({ action: "deleted", name }))));
  }
  return fail("error", `unknown nodetpl action ${action}`);
}

function writeJobFile(doc) {
  const file = options.get("--job-file");
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ log: [], started: "", updated: "", ...doc }));
  fs.renameSync(`${file}.tmp`, file);
}

async function job() {
  const ref = positionals[0];
  const result = { ref, status: "built", tag: "vrnetlab/cisco_vios:159-3.M3", nodetpl: { name: templateEntry("vrnetlab/cisco_vios:159-3.M3").name, written: false } };
  writeJobFile({ state: "running", phase: "download", pct: 10, message: "working", log: [`start ${PASSWORD}`] });
  process.on("SIGTERM", () => {
    writeJobFile({ state: "cancelled", phase: "build", pct: 10, message: "cancelled" });
    out({ error: { code: "cancelled", message: "cancelled" } });
    if (env.FAKE_CLIMG_IGNORE_TERM === "1") return;
    process.exit(4);
  });
  await wait(Number(env.FAKE_CLIMG_JOB_MS ?? 100));
  if (ref === "labhub:fail") {
    writeJobFile({ state: "failed", phase: "build", pct: 10, message: "build failed", result: { error: { code: "build_failed", message: "build failed" } } });
    fail("build_failed", `build failed ${PASSWORD}`);
  }
  writeJobFile({ state: "succeeded", phase: "done", pct: 100, message: "done", result });
  out(result);
}

switch (command) {
  case "config":
    out({
      contract_version: 1, version: "0.1.0", config_file: env.CLIMG_CONFIG ?? "", config_exists: true, state_dir: stateDir,
      images_dirs: [imagesDir], disk_floor_gb: 1, disk_floor_bytes: Number(env.FAKE_DISK_FLOOR ?? 1000), max_builds: 2,
      mirrors: ["main"], index_ttl_hours: 168, vrnetlab: "/tmp/vrnetlab", workspace: path.dirname(path.dirname(env.FAKE_NODETPL_FILE ?? "/x/ui/y")),
      nodetpl_file: env.FAKE_NODETPL_FILE ?? "", nodetpl_writer: "file", nodetpl_url: "", credentials_set: PASSWORD !== ""
    });
    break;
  case "doctor":
    out([{ check: "config", status: "ok", detail: `password ${PASSWORD}` }, { check: "/dev/kvm", status: env.FAKE_NO_KVM ? "FAIL" : "ok", detail: "" }]);
    process.exit(env.FAKE_NO_KVM ? 1 : 0);
    break;
  case "index":
    out({ release: "R1", age: "1h", counts: { QEMU: 1 }, buildable: 1 });
    break;
  case "search":
    out([RECORD]);
    break;
  case "show":
    if (positionals[0] === "labhub:nope") fail("not_found", "no LabHub entry");
    out({ ...RECORD, predicted_tag: RECORD.tag, files: [], detail: `pw ${PASSWORD}` });
    break;
  case "images":
    out([{ tag: "vrnetlab/cisco_vios:159-3.M3", kind: "cisco_vios", built: true, dangling: false }]);
    break;
  case "scan":
    out([]);
    break;
  case "nodetpl":
    await nodetpl();
    break;
  case "pull":
  case "build":
  case "add":
    await job();
    break;
  default:
    process.stderr.write(`unknown command ${command}\n`);
    process.exit(2);
}
