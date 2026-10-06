import { Router, Request, Response } from "express";
import multer from "multer";
import { prisma } from "../config/prisma";
import { requireAuth } from "../security/auth";
import { recordAuditLog } from "../services/auditLog";
import { processCallAudio } from "../services/telephony";
import {
  CallDirection,
  CallStatus,
  CallDraftStatus,
  CallIntentType,
  ClaimStatus,
  PipelineStage,
  InsuranceBranch,
} from "@prisma/client";

const upload = multer({
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

export const callsRouter = Router();

/**
 * Upload manual de gravação de ligação telefônica (Canal 3 de Apoio)
 * Exige obrigatoriamente confirmação de consentimento legal do cliente.
 */
callsRouter.post(
  "/upload",
  requireAuth,
  upload.single("audio"),
  async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: "Nenhum arquivo de áudio enviado." });
      return;
    }

    const consentConfirmed = req.body.consentConfirmed === "true" || req.body.consentConfirmed === true;
    if (!consentConfirmed) {
      res.status(400).json({
        error: "Consentimento legal obrigatório: você deve confirmar que o cliente foi cientificado da gravação da chamada.",
      });
      return;
    }

    const fromPhone = req.body.fromPhone || "Desconhecido";
    const toPhone = req.body.toPhone || "Corretora";
    const durationSeconds = parseInt(req.body.durationSeconds || "60", 10);

    // Localiza segurado se houver
    const cleanPhone = fromPhone.replace(/\D/g, "");
    const insured = cleanPhone
      ? await prisma.insured.findFirst({
          where: {
            brokerageId: req.user!.brokerageId,
            phone: { contains: cleanPhone.slice(-8) },
          },
        })
      : null;

    // Cria registro de chamada
    const callRecord = await prisma.callRecord.create({
      data: {
        brokerageId: req.user!.brokerageId,
        insuredId: insured?.id,
        fromPhone,
        toPhone,
        direction: CallDirection.INBOUND,
        status: CallStatus.COMPLETED,
        durationSeconds,
        recordingFile: req.file.originalname,
        summary: "Processando áudio com IA...",
        draftStatus: CallDraftStatus.PENDING,
      },
    });

    // Processa áudio (Whisper + Claude Sonnet 4.5)
    let processedCall;
    try {
      processedCall = await processCallAudio({
        callRecordId: callRecord.id,
        audioBuffer: req.file.buffer,
        mimeType: req.file.mimetype,
        durationSeconds,
      });
    } catch (err: any) {
      console.error("Erro no processamento do áudio da chamada:", err);
      processedCall = callRecord;
    }

    await recordAuditLog({
      brokerageId: req.user!.brokerageId,
      userId: req.user!.userId,
      action: "UPLOAD_CALL_RECORDING",
      resource: `CallRecord:${callRecord.id}`,
      details: { fileName: req.file.originalname, durationSeconds },
      req,
    });

    res.json({
      success: true,
      message: "Gravação enviada e processada com sucesso.",
      call: processedCall,
    });
  }
);

/**
 * Listagem das ligações da corretora (com isolamento multi-tenant estrito e métricas de custo)
 */
callsRouter.get("/", requireAuth, async (req: Request, res: Response) => {
  const brokerageId = req.user!.brokerageId;
  const draftStatus = req.query.draftStatus as CallDraftStatus | undefined;

  const whereClause: any = { brokerageId };
  if (draftStatus) {
    whereClause.draftStatus = draftStatus;
  }

  const calls = await prisma.callRecord.findMany({
    where: whereClause,
    include: {
      insured: { select: { id: true, name: true, phone: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  // Métricas do Mês Corrente
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const monthCalls = await prisma.callRecord.findMany({
    where: {
      brokerageId,
      createdAt: { gte: startOfMonth },
    },
    select: {
      estimatedCost: true,
      durationSeconds: true,
      status: true,
      draftStatus: true,
    },
  });

  const totalCost = monthCalls.reduce(
    (sum, c) => sum + (c.estimatedCost ? Number(c.estimatedCost) : 0),
    0
  );
  const pendingDrafts = monthCalls.filter((c) => c.draftStatus === CallDraftStatus.PENDING).length;
  const missedCalls = monthCalls.filter((c) => c.status === CallStatus.NO_ANSWER).length;

  res.json({
    calls,
    metrics: {
      monthTotalCalls: monthCalls.length,
      monthEstimatedCostBrl: Math.round(totalCost * 100) / 100,
      pendingDraftsCount: pendingDrafts,
      missedCallsCount: missedCalls,
    },
  });
});

/**
 * Obter detalhes da chamada e registrar log de auditoria
 */
callsRouter.get("/:id", requireAuth, async (req: Request, res: Response) => {
  const call = await prisma.callRecord.findFirst({
    where: {
      id: req.params.id,
      brokerageId: req.user!.brokerageId,
    },
    include: {
      insured: true,
    },
  });

  if (!call) {
    res.status(404).json({ error: "Ligação não encontrada" });
    return;
  }

  await recordAuditLog({
    brokerageId: req.user!.brokerageId,
    userId: req.user!.userId,
    action: "VIEW_CALL_RECORDING",
    resource: `CallRecord:${call.id}`,
    req,
  });

  res.json(call);
});

/**
 * Confirma o rascunho de uma chamada e converte em Sinistro ou Oportunidade no Funil
 */
callsRouter.patch("/:id/confirm", requireAuth, async (req: Request, res: Response) => {
  const { id } = req.params;
  const { action, editedData } = req.body; // action: "CREATE_CLAIM" | "CREATE_CARD" | "DISCARD"

  const call = await prisma.callRecord.findFirst({
    where: { id, brokerageId: req.user!.brokerageId },
    include: { insured: true },
  });

  if (!call) {
    res.status(404).json({ error: "Ligação não encontrada" });
    return;
  }

  const data = editedData || (call.extractedData as any) || {};

  if (action === "CREATE_CLAIM") {
    // 1. Localiza apólice
    let policy = await prisma.policy.findFirst({
      where: {
        brokerageId: req.user!.brokerageId,
        insuredId: call.insuredId || undefined,
        status: "ACTIVE",
      },
    });

    // Se apólice não existe mas foi citada, cria rascunho de apólice ou associa a apólice geral
    if (!policy && call.insuredId) {
      policy = await prisma.policy.create({
        data: {
          brokerageId: req.user!.brokerageId,
          insuredId: call.insuredId,
          policyNumber: data.policyNumber || `TEMP-${Date.now()}`,
          insurerName: data.insurer || "A Confirmar",
          startDate: new Date(),
          endDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
          premiumAmount: 0,
        },
      });
    }

    if (!policy) {
      res.status(400).json({
        error: "Para abrir um sinistro, vincule a chamada a um segurado ou informe o número da apólice.",
      });
      return;
    }

    const claim = await prisma.claim.create({
      data: {
        brokerageId: req.user!.brokerageId,
        insuredId: policy.insuredId,
        policyId: policy.id,
        incidentType: data.intent === "SINISTRO" ? "Colisão/Sinistro" : "Ocorrência Telefônica",
        incidentDate: new Date(),
        incidentLocation: data.location || "Local a confirmar",
        description: `[Gerado via Ligação Transcrita]\nResumo: ${call.summary}\nDetalhes: ${call.transcription?.slice(0, 500)}`,
        status: ClaimStatus.OPEN,
      },
    });

    const updatedCall = await prisma.callRecord.update({
      where: { id },
      data: {
        draftStatus: CallDraftStatus.CONFIRMED,
        createdClaimId: claim.id,
      },
    });

    await recordAuditLog({
      brokerageId: req.user!.brokerageId,
      userId: req.user!.userId,
      action: "CONVERT_CALL_TO_CLAIM",
      resource: `Claim:${claim.id}`,
      details: { callRecordId: id },
      req,
    });

    res.json({
      success: true,
      message: "Sinistro gerado com sucesso a partir da ligação!",
      claimId: claim.id,
      call: updatedCall,
    });
    return;
  }

  if (action === "CREATE_CARD") {
    const card = await prisma.pipelineCard.create({
      data: {
        brokerageId: req.user!.brokerageId,
        insuredId: call.insuredId,
        title: `Cotação via Chamada: ${call.insured ? call.insured.name : call.fromPhone}`,
        stage: PipelineStage.COTACAO,
        notes: `[Gerado via Ligação Transcrita]\n${call.summary}\nPróximos passos: ${data.nextSteps || "Enviar cotação"}`,
      },
    });

    const updatedCall = await prisma.callRecord.update({
      where: { id },
      data: {
        draftStatus: CallDraftStatus.CONFIRMED,
        createdCardId: card.id,
      },
    });

    await recordAuditLog({
      brokerageId: req.user!.brokerageId,
      userId: req.user!.userId,
      action: "CONVERT_CALL_TO_LEAD",
      resource: `PipelineCard:${card.id}`,
      details: { callRecordId: id },
      req,
    });

    res.json({
      success: true,
      message: "Oportunidade adicionada ao Funil de Vendas com sucesso!",
      cardId: card.id,
      call: updatedCall,
    });
    return;
  }

  if (action === "DISCARD") {
    const updatedCall = await prisma.callRecord.update({
      where: { id },
      data: { draftStatus: CallDraftStatus.DISCARDED },
    });

    res.json({
      success: true,
      message: "Rascunho de ligação descartado.",
      call: updatedCall,
    });
    return;
  }

  res.status(400).json({ error: "Ação inválida. Utilize CREATE_CLAIM, CREATE_CARD ou DISCARD." });
});
