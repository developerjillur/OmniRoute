import fs from "node:fs";
import path from "node:path";
const [directory, owner] = process.argv.slice(2);
try {
  const pidFile = path.join(directory, "pid");
  if (fs.readFileSync(pidFile, "utf8").trim() === owner) {
    fs.unlinkSync(pidFile);
    fs.rmdirSync(directory);
  }
} catch {}
