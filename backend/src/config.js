import "dotenv/config";
import path from "node:path";

function integerFromEnv(name, fallback, minimum, maximum) {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} muss zwischen ${minimum} und ${maximum} liegen.`);
  }
  return value;
}

// CORS bleibt auf die tatsächlichen Frontends begrenzt. Weitere Origins werden
// für den eigenen Server direkt in backend/.env kommasepariert eingetragen.
const defaultFrontendOrigins = [
  "https://wigipedia.netlify.app",
  "http://127.0.0.1:5501",
  "http://127.0.0.1:8080",
  "http://localhost:5501",
  "http://localhost:8080"
];
const frontendOriginsInput = process.env.FRONTEND_ORIGINS?.trim()
  ? process.env.FRONTEND_ORIGINS.split(",")
  : [...defaultFrontendOrigins, process.env.FRONTEND_ORIGIN?.trim()].filter(Boolean);

const adminPassword = process.env.ADMIN_PASSWORD ?? (process.env.NODE_ENV === "production" ? "" : "2011");
if (!adminPassword) {
  throw new Error("ADMIN_PASSWORD muss in der Produktionsumgebung gesetzt sein.");
}

let frontendOrigins;
try {
  // URL.origin entfernt einen versehentlichen abschließenden Slash zuverlässig.
  frontendOrigins = [...new Set(frontendOriginsInput.map((origin) => new URL(origin.trim()).origin))];
} catch {
  throw new Error("FRONTEND_ORIGINS muss vollständige, kommaseparierte http(s)-URLs enthalten.");
}

export const config = Object.freeze({
  host: process.env.HOST?.trim() || "127.0.0.1",
  port: integerFromEnv("PORT", 3000, 1, 65535),
  nodeEnv: process.env.NODE_ENV ?? "development",
  frontendOrigins,
  databasePath: path.resolve(process.cwd(), process.env.DATABASE_PATH ?? "./data/watt-casino.sqlite"),
  sessionDays: integerFromEnv("SESSION_DAYS", 30, 1, 365),
  bcryptRounds: integerFromEnv("BCRYPT_ROUNDS", 12, 10, 15),
  trustProxy: integerFromEnv("TRUST_PROXY", 0, 0, 10),
  adminPassword
});
