import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("./bootstrap-launchdaemon.sh", import.meta.url));
function run(initial, mode = "reload") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-launchd-fixture-"));
  const state = path.join(dir, "state.json"),
    trace = path.join(dir, "trace.txt");
  fs.writeFileSync(state, JSON.stringify(initial));
  fs.writeFileSync(path.join(dir, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(
    path.join(dir, "launchctl"),
    `#!${process.execPath}
const fs = require("node:fs");
const p=process.env.FIXTURE_STATE, args=process.argv.slice(2), s=JSON.parse(fs.readFileSync(p,"utf8"));
fs.appendFileSync(process.env.FIXTURE_TRACE,args.join(" ")+"\\n");
let code=0;
if(args[0]==="print") {
  if(s.removing && !s.neverRemove) {s.removing--;if(!s.removing)s.loaded=false;}
  code=s.loaded?0:3;
} else if(args[0]==="bootout") {s.removing=s.neverRemove?1:3;}
else if(args[0]==="bootstrap") {
  if(s.partial) {s.loaded=true;code=5;}
  else if(s.failures>0) {s.failures--;code=5;}
  else if(s.alwaysFail) code=5;
  else s.loaded=true;
}
fs.writeFileSync(p,JSON.stringify(s));process.exit(code);
`,
    { mode: 0o755 }
  );
  const result = spawnSync("/bin/bash", [helper, "fixture.ingress", "/fixture.plist", mode], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: dir + path.delimiter + process.env.PATH,
      FIXTURE_STATE: state,
      FIXTURE_TRACE: trace,
    },
  });
  return {
    result,
    state: JSON.parse(fs.readFileSync(state, "utf8")),
    trace: fs.readFileSync(trace, "utf8").trim().split("\n"),
  };
}
test("waits for old daemon teardown and retries transient bootstrap failure", () => {
  const { result, state, trace } = run({ loaded: true, failures: 1 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(state.loaded, true);
  const firstBootstrap = trace.findIndex((x) => x.startsWith("bootstrap"));
  assert.ok(trace.slice(0, firstBootstrap).filter((x) => x.startsWith("print")).length >= 4);
  assert.equal(trace.filter((x) => x.startsWith("bootstrap")).length, 2);
});
test("an error response with an actually registered daemon is accepted", () => {
  const { result, state, trace } = run({ loaded: false, partial: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(state.loaded, true);
  assert.equal(trace.filter((x) => x.startsWith("bootstrap")).length, 1);
});
test("persistent bootstrap failure remains a reported failure", () => {
  const { result, trace } = run({ loaded: false, alwaysFail: true });
  assert.equal(result.status, 1);
  assert.equal(trace.filter((x) => x.startsWith("bootstrap")).length, 5);
  assert.match(result.stderr, /could not be loaded/);
});
test("unfinished teardown never attempts a duplicate bootstrap", () => {
  const { result, trace } = run({ loaded: true, neverRemove: true });
  assert.equal(result.status, 1);
  assert.equal(
    trace.some((x) => x.startsWith("bootstrap")),
    false
  );
  assert.match(result.stderr, /teardown did not finish/);
});

test("an unchanged loaded daemon is left running without a bootstrap or bootout", () => {
  const { result, trace } = run({ loaded: true }, "keep");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(trace, ["print system/fixture.ingress"]);
});
