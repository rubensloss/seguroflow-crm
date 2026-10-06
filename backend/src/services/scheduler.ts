import { runBillingCadenceScan } from "./billingCadence";
import { runRenewalsScan } from "./renewalsEngine";

/**
 * Agendador interno autônomo do SeguroFlow
 * Executa diariamente às 09:00 (Horário de Brasília / 12:00 UTC)
 * as varreduras da régua de cobrança preventiva e renovações.
 */
let schedulerInterval: NodeJS.Timeout | null = null;
let lastExecutedDateStr = "";

export function startInternalScheduler() {
  console.log("⏰ [Scheduler SeguroFlow] Iniciando serviço de agendamento automático diário...");

  // Checa a cada 10 minutos se atingiu o horário das 09h BRT
  const CHECK_INTERVAL_MS = 10 * 60 * 1000;

  async function checkAndRun() {
    const now = new Date();
    // Horário de Brasília (UTC-3)
    const brtHours = (now.getUTCHours() - 3 + 24) % 24;
    const todayStr = now.toISOString().slice(0, 10);

    // Se estiver entre 09:00 e 09:59 e ainda não rodou hoje
    if (brtHours >= 9 && lastExecutedDateStr !== todayStr) {
      console.log(`🚀 [Scheduler SeguroFlow] Disparando rotinas diárias automáticas (${todayStr} às ${brtHours}h BRT)...`);
      try {
        lastExecutedDateStr = todayStr;
        
        // 1. Régua de cobrança preventiva (D-7, D-0, D+2)
        const cadenceResult = await runBillingCadenceScan();
        console.log(`✅ [Scheduler SeguroFlow] Régua de cobrança concluída:`, cadenceResult);

        // 2. Motor de renovação ativa (60d, 30d, 15d)
        const renewalsResult = await runRenewalsScan();
        console.log(`✅ [Scheduler SeguroFlow] Varredura de renovações concluída:`, renewalsResult);
      } catch (err) {
        console.error("❌ [Scheduler SeguroFlow] Erro durante execução automática diária:", err);
      }
    }
  }

  // Executa uma checagem inicial leve após 15 segundos da inicialização do container
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
