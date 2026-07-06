import { spawn } from "node:child_process";
import path from "node:path";
import { randomBytes } from "node:crypto";

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".htm", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".txt", "text/plain; charset=utf-8"],
  [".pdf", "application/pdf"]
]);

export function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}

export function parseDurationSeconds(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || raw === "off" || raw === "false" || raw === "0") return 0;
  const match = /^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)?$/.exec(raw);
  if (!match) return 0;
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2] || "s";
  if (["w", "week", "weeks"].includes(unit)) return amount * 7 * 24 * 3600;
  if (["d", "day", "days"].includes(unit)) return amount * 24 * 3600;
  if (["h", "hr", "hrs", "hour", "hours"].includes(unit)) return amount * 3600;
  if (["m", "min", "mins", "minute", "minutes"].includes(unit)) return amount * 60;
  return amount;
}

export function formatDuration(seconds) {
  if (!seconds) return "off";
  if (seconds % (7 * 24 * 3600) === 0) return `${seconds / (7 * 24 * 3600)}w`;
  if (seconds % (24 * 3600) === 0) return `${seconds / (24 * 3600)}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

export function publicBaseFromServer(serverUrl, defaultServerUrl) {
  return String(serverUrl || defaultServerUrl)
    .replace(/^ws:/, "http:")
    .replace(/^wss:/, "https:")
    .replace(/\/tunnel$/, "");
}

export function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function nonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function randomId(bytes) {
  return randomBytes(bytes).toString("base64url");
}

export function contentType(filePath) {
  return MIME_TYPES.get(path.extname(filePath).toLowerCase()) || "application/octet-stream";
}

export function copyToClipboard(text) {
  if (process.platform !== "darwin") return;
  try {
    const proc = spawn("pbcopy");
    proc.on("error", () => {});
    proc.stdin.end(text);
  } catch {
    // Clipboard is a convenience only.
  }
}

export function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "";
}
