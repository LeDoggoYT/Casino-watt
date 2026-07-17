import express from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { config } from "./config.js";
import { cleanupExpiredData } from "./db.js";
import { ApiError, fail, ok } from "./responses.js";
import { authRouter } from "./routes/auth-routes.js";
import { gameRouter } from "./routes/game-routes.js";
import { playerRouter } from "./routes/player-routes.js";
import { activityRouter } from "./routes/activity-routes.js";
import { adminRouter } from "./routes/admin-routes.js";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", config.trustProxy);
app.use(helmet());
const corsOptions = {
  origin(origin, callback) {
    // Requests ohne Origin sind keine Browser-CORS-Anfragen (z. B. Railway Healthchecks).
    if (!origin) return callback(null, true);
    try {
      return callback(null, new URL(origin).origin === config.frontendOrigin);
    } catch {
      return callback(null, false);
    }
  },
  methods: ["GET", "POST", "PATCH", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type"],
  maxAge: 86400,
  optionsSuccessStatus: 204
};
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
app.use(express.json({ limit: "20kb", strict: true }));

const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 180,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { success: false, data: {}, message: "Zu viele Anfragen. Bitte kurz warten." }
});
const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { success: false, data: {}, message: "Zu viele Anmeldeversuche. Bitte später erneut versuchen." }
});
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { success: false, data: {}, message: "Zu viele Admin-Anmeldeversuche. Bitte später erneut versuchen." }
});

app.get("/health", (_req, res) => ok(res, { status: "ok" }));
app.use("/api", apiLimiter);
app.use("/api/auth/register", authLimiter);
app.use("/api/auth/login", authLimiter);
app.use("/api/admin/login", adminLoginLimiter);
app.use("/api/auth", authRouter);
app.use("/api/admin", adminRouter);
app.use("/api/game", gameRouter);
app.use("/api", playerRouter);
app.use("/api", activityRouter);

app.use((_req, res) => fail(res, 404, "Endpunkt nicht gefunden."));
app.use((error, _req, res, _next) => {
  if (error instanceof ApiError) return fail(res, error.status, error.message);
  if (error?.type === "entity.parse.failed") return fail(res, 400, "Ungültiges JSON.");
  console.error("API-Fehler:", error instanceof Error ? error.message : "Unbekannter Fehler");
  return fail(res, 500, "Die Anfrage konnte nicht verarbeitet werden.");
});

cleanupExpiredData();
setInterval(cleanupExpiredData, 60 * 60_000).unref();

app.listen(config.port, () => {
  console.log(`Watt Casino API läuft auf Port ${config.port}.`);
});
