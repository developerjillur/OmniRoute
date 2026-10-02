import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  signalUnchangedFileWrite,
  hasNativeHostsEntries,
  nativeHostsRoutingEnabled,
} from "./refresh-native-dns.mjs";

test("resolver reload write preserves every Local, OmniRoute and native hosts byte", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-dns-preserve-"));
  const file = path.join(dir, "hosts");
  const bytes = Buffer.from(
    "# local hosts\n127.0.0.1 project.local #Local Site\n127.0.0.2 omni.local\n127.0.0.1 api.anthropic.com\n::1 api.anthropic.com\n"
  );
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  const inode = fs.statSync(file).ino;
  signalUnchangedFileWrite(file);
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(fs.statSync(file).ino, inode);
  assert.equal(hasNativeHostsEntries(bytes.toString()), true);
});
test("DNS repair rejects incomplete or commented-out native routing", () => {
  assert.equal(
    hasNativeHostsEntries("# 127.0.0.1 api.anthropic.com\n::1 api.anthropic.com\n"),
    false
  );
  assert.equal(
    hasNativeHostsEntries("127.0.0.1 api.anthropic.com.evil\n::1 api.anthropic.com\n"),
    false
  );
});
test("installation preserves stopped DNS intent and refuses partial routing", () => {
  assert.equal(
    nativeHostsRoutingEnabled("127.0.0.1 project.local\n# ::1 api.anthropic.com\n"),
    false
  );
  assert.throws(() => nativeHostsRoutingEnabled("127.0.0.1 api.anthropic.com\n"), /Incomplete/);
  assert.throws(() => nativeHostsRoutingEnabled("160.79.104.10 api.anthropic.com\n"), /Incomplete/);
  assert.equal(
    nativeHostsRoutingEnabled("127.0.0.1 api.anthropic.com\n::1 api.anthropic.com\n"),
    true
  );
});
