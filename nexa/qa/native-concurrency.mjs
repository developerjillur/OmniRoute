import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
const args = process.argv.slice(2);
const usage =
  "Usage: node nexa/qa/native-concurrency.mjs --live --output-dir /absolute/new-directory [--cli /path/to/claude] [--data-dir /path/to/data]";
if (args.includes("--help") || args.length === 0) {
  console.log(usage);
  process.exit(0);
}
const option = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
if (!args.includes("--live")) throw Error("Live provider requests require --live. " + usage);
const output = option("--output-dir");
if (!output || !path.isAbsolute(output)) throw Error("A fresh absolute --output-dir is required");
const cli = option("--cli") || "claude";
if (
  ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"].some(
    (name) => process.env[name]
  )
)
  throw Error("Native first-party QA requires no inherited API overrides");
const auth = JSON.parse(execFileSync(cli, ["auth", "status"], { encoding: "utf8" }));
if (!auth.loggedIn || auth.apiProvider !== "firstParty")
  throw Error("Native first-party login is required");
const data = option("--data-dir") || path.join(os.homedir(), ".omniroute-local");
const root = output;
const record = path.join(data, "mitm", ".mitm.pid");
if (!fs.existsSync(record)) throw Error("A running Bridge PID record is required");
fs.mkdirSync(root, { mode: 0o700 });
const work = path.join(root, "native-synthetic-workspace");
fs.mkdirSync(work, { mode: 0o700 });
const beforePid = fs.readFileSync(record, "utf8");
const sessions = [
  "claude-sonnet-5-5",
  "claude-opus-5-5",
  "claude-sonnet-4-6",
  "claude-opus-4-5-20251101",
].map((model, i) => ({
  model,
  sid: randomUUID(),
  marker: ["Atlas Inventory", "Birch Delivery", "Cedar Gallery", "Dune Reports"][i],
}));
function run(label, args, { marker, cancel = false, forbidden = [] } = {}) {
  return new Promise((resolve) => {
    const out = fs.createWriteStream(path.join(root, label + ".jsonl"), { mode: 0o600 });
    const err = fs.createWriteStream(path.join(root, label + ".stderr"), { mode: 0o600 });
    const child = spawn(cli, args, { cwd: work, stdio: ["ignore", "pipe", "pipe"] });
    let full = "",
      buffer = "",
      cancelled = false,
      sawPartial = false,
      timeout = false;
    const started = Date.now();
    const deadline = setTimeout(() => {
      timeout = true;
      child.kill("SIGTERM");
    }, 120000);
    child.stdout.on("data", (bytes) => {
      out.write(bytes);
      full += bytes.toString();
      buffer += bytes.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const l of lines) {
        try {
          const e = JSON.parse(l);
          if (
            cancel &&
            e.type === "stream_event" &&
            ["text_delta", "thinking_delta"].includes(e.event?.delta?.type) &&
            !cancelled
          ) {
            sawPartial = true;
            cancelled = true;
            setTimeout(() => child.kill("SIGTERM"), 50);
          }
        } catch {}
      }
    });
    child.stderr.pipe(err);
    child.on("error", (e) => {
      clearTimeout(deadline);
      out.end();
      err.end();
      resolve({ label, ok: false, error: e.message });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(deadline);
      out.end();
      err.end();
      const entries = [];
      for (const l of full.trim().split("\n")) {
        try {
          entries.push(JSON.parse(l));
        } catch {}
      }
      const final = entries.findLast((e) => e.type === "result");
      const reply = String(final?.result || "");
      const result = {
        label,
        ok: cancel
          ? sawPartial && cancelled && !timeout
          : Boolean(final) &&
            code === 0 &&
            !final.is_error &&
            !timeout &&
            reply.includes(marker) &&
            forbidden.every((x) => !reply.includes(x)),
        exitCode: code,
        signal,
        ms: Date.now() - started,
        streamEvents: entries.filter((e) => e.type === "stream_event").length,
        sawPartial,
        cancelled,
        timeout,
        model: Object.keys(final?.modelUsage || {}),
      };
      fs.writeFileSync(path.join(root, label + ".summary.json"), JSON.stringify(result), {
        mode: 0o600,
      });
      console.log(JSON.stringify(result));
      resolve(result);
    });
  });
}
const base = [
  "-p",
  "--tools",
  "",
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
];
const start = await Promise.all(
  sessions.map((s, i) =>
    run(
      "qa-multi-start-" + i,
      [
        ...base,
        "--model",
        s.model,
        "--session-id",
        s.sid,
        `Our project is named ${s.marker}. Write a heading with the project name, then 20 short numbered Bengali lines suggesting software verification tasks for this project, then repeat the project name as the final line.`,
      ],
      { marker: s.marker }
    )
  )
);
const resume = await Promise.all(
  sessions.map((s, i) =>
    run(
      "qa-multi-resume-" + i,
      [
        ...base,
        "--model",
        s.model,
        "--resume",
        s.sid,
        "What is the name of the project we discussed in the previous message? Please give its exact English name.",
      ],
      { marker: s.marker, forbidden: sessions.filter((x) => x !== s).map((x) => x.marker) }
    )
  )
);
const cancellation = await Promise.all([
  run(
    "qa-multi-cancelled-stream",
    [
      ...base,
      "--model",
      "claude-opus-5-5",
      "--effort",
      "low",
      "Print the integers from 1 through 500, one per line, without explanations or tools.",
    ],
    { cancel: true }
  ),
  ...sessions
    .slice(0, 3)
    .map((s, i) =>
      run(
        "qa-multi-survivor-" + i,
        [
          ...base,
          "--model",
          s.model,
          "Write STREAM_BEGIN, then 60 short numbered Bengali lines about verification, then SURVIVOR_OK.",
        ],
        { marker: "SURVIVOR_OK" }
      )
    ),
]);
const summary = {
  ok:
    [...start, ...resume, ...cancellation].every((r) => r.ok) &&
    beforePid === fs.readFileSync(record, "utf8"),
  fourParallelSessions: true,
  privateContextIsolation: resume.every((r) => r.ok),
  oneStreamCancelledOthersSurvived: cancellation.every((r) => r.ok),
  listenerPidPreserved: beforePid === fs.readFileSync(record, "utf8"),
  results: [...start, ...resume, ...cancellation],
};
fs.writeFileSync(
  path.join(root, "native-concurrency-summary.json"),
  JSON.stringify(summary, null, 2),
  { mode: 0o600 }
);
if (!summary.ok) process.exitCode = 1;
