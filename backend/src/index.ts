import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import "express-async-errors";
import { env } from "./config/env";
import { prisma } from "./config/prisma";

import { authRouter } from "./routes/auth";
import { whatsappCloudWebhookRouter } from "./routes/webhooks/whatsappCloud";
import { brokeragesRouter } from "./routes/brokerages";
import { insuredsRouter } from "./routes/insureds";
import { policiesRouter } from "./routes/policies";
import { installmentsRouter } from "./routes/installments";
import { claimsRouter } from "./routes/claims";
import { pipelineRouter } from "./routes/pipeline";
import { renewalsRouter } from "./routes/renewals";
import { documentsRouter } from "./routes/documents";
import { importRouter } from "./routes/import";
import { dashboardRouter } from "./routes/dashboard";
import { privacyRouter } from "./routes/privacy";
import { conversationsRouter } from "./routes/conversations";
import { financesRouter } from "./routes/finances";
import { clientPortalRouter } from "./routes/clientPortal";
import { cronRouter } from "./routes/cron";
import { telephonyRouter } from "./routes/telephony";
import { callsRouter } from "./routes/calls";
import { startInternalScheduler, getSchedulerStatus } from "./services/scheduler";

const app = express();

// Segurança
app.use(helmet());
app.use(
  cors({
    origin: env.CORS_ORIGIN === "*" ? "*" : env.CORS_ORIGIN.split(","),
    credentials: true,
  })
);

// Captura do corpo bruto (rawBody) necessário para validar a assinatura X-Hub-Signature-256 da Meta
app.use(
  express.json({
    limit: "20mb",
    verify: (req: Request, _res: Response, buf: Buffer) => {
      (req as any).rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

// Rota de Health Check
app.get("/health", async (_req: Request, res: Response) => {
  let dbOk = false;
  let hasWhatsAppConfigured = false;

  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
  } catch {
    dbOk = false;
  }

  if (dbOk) {
    try {
      const brkWithMeta = await prisma.brokerage.findFirst({
        where: {
          whatsappPhoneNumberId: { not: null },
          whatsappAccessTokenEncrypted: { not: null },
        },
        select: { id: true },
      });
      hasWhatsAppConfigured = Boolean(brkWithMeta);
    } catch {
      hasWhatsAppConfigured = false;
    }
  }

  const schedulerInfo = getSchedulerStatus();
  const anthropicKey = process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY;

  res.json({
    status: "ok",
    service: "SeguroFlow Backend API",
    brand: "Creative Always",
    version: "1.0.0",
    ecosystem: "https://creativealways.com.br/solucoes/",
    database: dbOk ? "connected" : "disconnected",
    scheduler: schedulerInfo.status,
    schedulerDetails: schedulerInfo,
    integrations: {
      anthropic: anthropicKey ? "configured" : "missing",
      whatsapp: hasWhatsAppConfigured ? "configured" : "missing",
      openai: Boolean(process.env.OPENAI_API_KEY || env.OPENAI_API_KEY) ? "configured" : "missing",
    },
    timestamp: new Date().toISOString(),
  });
});

// Rotas da API
app.use("/api/auth", authRouter);
app.use("/api/webhooks/whatsapp", whatsappCloudWebhookRouter);
app.use("/api/brokerages", brokeragesRouter);
app.use("/api/insureds", insuredsRouter);
app.use("/api/policies", policiesRouter);
app.use("/api/installments", installmentsRouter);
app.use("/api/claims", claimsRouter);
app.use("/api/pipeline", pipelineRouter);
app.use("/api/renewals", renewalsRouter);
app.use("/api/documents", documentsRouter);
app.use("/api/import", importRouter);
app.use("/api/dashboard", dashboardRouter);
app.use("/api/privacy", privacyRouter);
app.use("/api/conversations", conversationsRouter);
app.use("/api/finances", financesRouter);
app.use("/api/client-portal", clientPortalRouter);
app.use("/api/cron", cronRouter);
app.use("/api/telephony", telephonyRouter);
app.use("/api/calls", callsRouter);

// Tratamento de Erros Global
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Erro interno do servidor SeguroFlow:", err);

  if (err.name === "ZodError") {
    res.status(400).json({ error: "Dados inválidos", details: err.errors });
    return;
  }

  res.status(err.status || 500).json({
    error: err.message || "Erro interno do servidor",
  });
});

const server = app.listen(env.PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 SeguroFlow Backend rodando na porta ${env.PORT}`);
  console.log(`🏢 Uma solução Creative Always (https://creativealways.com.br/solucoes/)`);
  console.log(`📡 Webhook Meta: http://localhost:${env.PORT}/api/webhooks/whatsapp`);
  console.log(`=======================================================`);
  
  // Inicia o motor autônomo de agendamento diário (Régua Preventiva & Renovações)
  startInternalScheduler();
});

// Encerramento Gracioso
process.on("SIGTERM", async () => {
  console.log("Recebido SIGTERM, encerrando servidor SeguroFlow com segurança...");
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
});

export { app };
