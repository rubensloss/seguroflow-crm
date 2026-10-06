import { Router, Request, Response } from "express";
import { runBillingCadenceScan } from "../services/billingCadence";
import { runRenewalsScan } from "../services/renewalsEngine";
import { env } from "../config/env";

export const cronRouter = Router();

/**
 * Endpoint de disparo para Railway Cron ou disparadores externos (ex.: cron-job.org)
 * Protegido por segredo x-cron-secret ou bearer token
 */
cronRouter.post("/daily-cadence", async (req: Request, res: Response) => {
  const authHeader = req.headers["x-cron-secret"] || req.headers.authorization;
  const expectedSecret = process.env.CRON_SECRET || env.JWT_SECRET;

  if (authHeader !== expectedSecret && authHeader !== `Bearer ${expectedSecret}`) {
    res.status(401).json({ error: "Acesso não autorizado ao gatilho do cron." });
    return;
  }

  console.log("⚡ [Gatilho Cron Externo] Iniciando varredura diária...");
  try {
    const billingResult = await runBillingCadenceScan();
    const renewalsResult = await runRenewalsScan();

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      billingResult,
      renewalsResult,
    });
  } catch (error) {
    console.error("Erro no gatilho cron:", error);
    res.status(500).json({ error: "Erro na execução das rotinas do cron." });
  }
});
