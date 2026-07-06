import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";

export function createEventRecorder(filePath) {
  if (!filePath) {
    return { record() {} };
  }

  mkdirSync(path.dirname(filePath), { recursive: true });
  const stream = createWriteStream(filePath, { flags: "a" });
  stream.on("error", (error) => {
    console.error(`event log error: ${error.message}`);
  });

  return {
    record(event) {
      const payload = {
        ts: new Date().toISOString(),
        ...event
      };
      stream.write(`${JSON.stringify(payload)}\n`);
    }
  };
}
