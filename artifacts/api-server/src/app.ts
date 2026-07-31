import express, { type Express } from "express";
import cors from "cors";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import pinoHttp from "pino-http";
import { logger } from "./lib/logger";
import { registerRoutes } from "./routes/routes";
import { storage } from "./storage";
import marketingRouter from "./routes/marketing";
import fileUpload from "express-fileupload";
import type { Server } from "http";

const PgSession = connectPgSimple(session);

export async function createApp(): Promise<{ app: Express; httpServer: Server }> {
  const app: Express = express();

  // Trust the first hop from the reverse proxy (Replit's TLS-terminating
  // proxy) so that req.secure is true and express-session issues
  // Secure cookies in production without them being silently dropped.
  app.set("trust proxy", 1);

  app.use(
    pinoHttp({
      logger,
      serializers: {
        req(req) {
          return {
            id: req.id,
            method: req.method,
            url: req.url?.split("?")[0],
          };
        },
        res(res) {
          return {
            statusCode: res.statusCode,
          };
        },
      },
    }),
  );
  // Global permissive CORS for the IrrigoPro app's same-origin frontend and
  // tooling. NOTE: /api/marketing-leads is intentionally exempted here so its
  // own strict per-route allowlist (artifacts/api-server/src/routes/marketing.ts)
  // is the only thing answering for that endpoint — otherwise this permissive
  // middleware would reflect any Origin and silently widen the marketing
  // allowlist.
  const globalCors = cors({ origin: true, credentials: true });
  app.use((req, res, next) => {
    if (req.path === "/api/marketing-leads") {
      return next();
    }
    return globalCors(req, res, next);
  });
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ extended: true, limit: "50mb" }));
  app.use(fileUpload({
    limits: { fileSize: 50 * 1024 * 1024 },
    useTempFiles: false,
  }));

  // Server-side session middleware. Uses PostgreSQL as the session store
  // so sessions survive process restarts. The session cookie is httpOnly
  // (not readable by JS) and is marked Secure in production.
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret && process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET must be set in production");
  }
  app.use(
    session({
      store: new PgSession({
        conString: process.env.DATABASE_URL,
        createTableIfMissing: true,
        tableName: "web_sessions",
      }),
      secret: sessionSecret ?? "dev-insecure-secret-change-me",
      resave: false,
      saveUninitialized: false,
      name: "irrigopro.sid",
      cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      },
    }),
  );

  app.use("/api", marketingRouter);

  // Task #1856: run the controller-letter backfill + DDL hardening BEFORE the
  // server starts accepting requests so no controller create can race a missing
  // NOT NULL constraint or absent unique index.  Failures throw and crash startup
  // (same philosophy as a failed DB schema migration).
  await storage.initialize();

  const httpServer = await registerRoutes(app);
  return { app, httpServer };
}
