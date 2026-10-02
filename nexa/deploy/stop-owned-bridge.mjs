import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function ownsBridgeCommand(command, runtime) {
  return [process.execPath, "/usr/local/bin/node"].some((node) =>
    ["src/mitm/server.cjs", "dist/src/mitm/server.cjs"].some(
      (relative) =>
        command.trim() === `${node} ${path.join(runtime, "lib/node_modules/omniroute", relative)}`
    )
  );
}

export async function stopOwnedBridge(data, runtime) {
  const record = path.join(data, "mitm/.mitm.pid");
  if (!fs.existsSync(record)) return { ok: true, stopped: false };
  if (!fs.lstatSync(record).isFile()) throw new Error("Bridge PID record is not a regular file");
  const raw = fs.readFileSync(record, "utf8").trim();
  const pid = Number(raw);
  const command = () => {
    try {
      return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    } catch {
      return "";
    }
  };
  const removeOwnRecord = () => {
    if (fs.existsSync(record) && fs.readFileSync(record, "utf8").trim() === raw)
      fs.unlinkSync(record);
  };
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 1 ||
    pid === process.pid ||
    !ownsBridgeCommand(command(), runtime)
  ) {
    removeOwnRecord();
    return { ok: true, stopped: false, staleRecordRemoved: true };
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!ownsBridgeCommand(command(), runtime)) {
      removeOwnRecord();
      return { ok: true, stopped: true };
    }
  }
  // The old runtime may lack bounded TLS shutdown. Revalidate the exact
  // command before escalating; never signal a reused or unrelated PID.
  if (ownsBridgeCommand(command(), runtime)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  removeOwnRecord();
  return { ok: true, stopped: true, forced: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await stopOwnedBridge(process.argv[2], process.argv[3])));
}
