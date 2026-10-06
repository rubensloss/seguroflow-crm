import { prisma } from "../config/prisma";
import { runBillingCadenceScan } from "./billingCadence";
import { runRenewalsScan } from "./renewalsEngine";

/**
 * Agendador interno autônomo do SeguroFlow
 * Executa estritamente entre 09:00 e 09:59 no Horário Oficial de Brasília (America/Sao_Paulo).
 * Persiste a execução no banco de dados (tabela audit_logs) para evitar execuções duplicadas
 * mesmo após reinicializações do container no Railway.
 */

let schedulerInterval: NodeJS.Timeout | null = null;
let lastExecutedDateStr = "";
let isExecuting = false;

/**
 * Retorna a data (YYYY-MM-DD) e hora (0..23) no fuso America/Sao_Paulo
 */
export function getSaoPauloDateAndHour(date: Date = new Date()): {
  dateStr: string;
  hour: number;
  minute: number;
} {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const year = parts.find((p) => p.type === "year")?.value || "";
  const month = parts.find((p) => p.type === "month")?.value || "";
  const day = parts.find((p) => p.type === "day")?.value || "";
  const hour = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);
  const minute = parseInt(parts.find((p) => p.type === "minute")?.value || "0", 10);

  return { dateStr: `${year}-${month}-${day}`, hour, minute };
}

/**
 * Retorna o status de saúde e execução do scheduler para o endpoint /health
 */
export function getSchedulerStatus() {
  const sp = getSaoPauloDateAndHour();
  return {
    status: schedulerInterval ? "active" : "inactive",
    running: Boolean(schedulerInterval),
    timezone: "America/Sao_Paulo",
    executionWindow: "09:00 - 09:59 BRT",
    currentSaoPauloTime: `${sp.dateStr} ${String(sp.hour).padStart(2, "0")}:${String(sp.minute).padStart(2, "0")}`,
    lastExecutedDate: lastExecutedDateStr || null,
  };
}

export function startInternalScheduler() {
  console.log("⏰ [Scheduler SeguroFlow] Iniciando serviço de agendamento automático diário (Fuso: America/Sao_Paulo)...");

  // Carrega imediatamente a data da última execução registrada no banco de dados
  prisma.auditLog
    .findFirst({
      where: { action: "DAILY_SWEEP_EXECUTED" },
      orderBy: { createdAt: "desc" },
      select: { resource: true },
    })
    .then((lastLog) => {
      if (lastLog?.resource?.startsWith("Scheduler:")) {
        lastExecutedDateStr = lastLog.resource.replace("Scheduler:", "");
        console.log(`ℹ️ [Scheduler SeguroFlow] Última execução registrada no banco: ${lastExecutedDateStr}`);
      }
    })
    .catch((err) => {
      console.warn("Não foi possível carregar última execução do scheduler do banco:", err?.message);
    });

  // Checa a cada 5 minutos
  const CHECK_INTERVAL_MS = 5 * 60 * 1000;

  async function checkAndRun() {
    if (isExecuting) return;

    const { dateStr, hour, minute } = getSaoPauloDateAndHour();

    // Regra estrita: apenas entre 09:00 e 09:59 no horário de Brasília
    if (hour !== 9) {
      return;
    }

    // Se a memória já registra execução hoje, ignora
    if (lastExecutedDateStr === dateStr) {
      return;
    }

    try {
      isExecuting = true;

      // Verifica persistência no banco de dados para evitar re-execução em restarts do Railway
      const alreadyRunInDb = await prisma.auditLog.findFirst({
        where: {
          action: "DAILY_SWEEP_EXECUTED",
          resource: `Scheduler:${dateStr}`,
        },
      });

      if (alreadyRunInDb) {
        lastExecutedDateStr = dateStr;
        console.log(`ℹ️ [Scheduler SeguroFlow] Rotina diária de ${dateStr} já foi executada e registrada no banco. Pulando.`);
        return;
      }

      console.log(`🚀 [Scheduler SeguroFlow] Disparando rotinas diárias automáticas em Brasília (${dateStr} às 09:${String(minute).padStart(2, "0")})...`);

      // 1. Régua de cobrança preventiva (D-7, D-0, D+2)
      const cadenceResult = await runBillingCadenceScan();
      console.log(`✅ [Scheduler SeguroFlow] Régua de cobrança concluída:`, cadenceResult);

      // 2. Motor de renovação ativa (60d, 30d, 15d)
      const renewalsResult = await runRenewalsScan();
      console.log(`✅ [Scheduler SeguroFlow] Varredura de renovações concluída:`, renewalsResult);

      // 3. Grava no banco de dados a confirmação de execução diária
      const firstBrokerage = await prisma.brokerage.findFirst({ select: { id: true } });
      if (firstBrokerage) {
        await prisma.auditLog.create({
          data: {
            brokerageId: firstBrokerage.id,
            action: "DAILY_SWEEP_EXECUTED",
            resource: `Scheduler:${dateStr}`,
            details: {
              saoPauloDate: dateStr,
              executedAt: new Date().toISOString(),
              cadenceResult,
              renewalsResult,
            },
          },
        });
      }

      lastExecutedDateStr = dateStr;
    } catch (err) {
      console.error("❌ [Scheduler SeguroFlow] Erro durante execução automática diária:", err);
    } finally {
      isExecuting = false;
    }
  }

  // Checagem inicial leve após 15 segundos da inicialização do servidor
  setTimeout(() => {
    checkAndRun().catch((e) => console.error("[Scheduler Error]:", e));
  }, 15000);

  schedulerInterval = setInterval(() => {
    checkAndRun().catch((e) => console.error("[Scheduler Error]:", e));
  }, CHECK_INTERVAL_MS);
}

export function stopInternalScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
}
