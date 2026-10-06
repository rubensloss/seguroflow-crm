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
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
  } catch {
    dbOk = false;
  }

  res.json({
    status: "ok",
    service: "SeguroFlow Backend API",
    brand: "Creative Always",
    version: "1.0.0",
    ecosystem: "https://creativealways.com.br/solucoes/",
    database: dbOk ? "connected" : "disconnected",
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
