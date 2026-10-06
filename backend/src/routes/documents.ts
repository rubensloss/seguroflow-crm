import { Router, Request, Response } from "express";
import multer from "multer";
import { DocumentType } from "@prisma/client";
import { prisma } from "../config/prisma";
import { requireAuth } from "../security/auth";
import { extractDocumentWithAi } from "../services/documentOcr";
import { recordAuditLog } from "../services/auditLog";

const upload = multer({
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

export const documentsRouter = Router();

// Upload e extração inteligente de documentos via IA Vision (Módulo 5)
documentsRouter.post(
  "/ocr",
  requireAuth,
  upload.single("file"),
  async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: "Nenhum arquivo enviado" });
      return;
    }

    const docTypeHint = req.body.docType as DocumentType | undefined;
    const insuredId = req.body.insuredId as string | undefined;

    let extraction;
    try {
      extraction = await extractDocumentWithAi(
        req.file.buffer,
        req.file.mimetype,
        docTypeHint
      );
    } catch (err: any) {
      res.status(422).json({
        error: "Não foi possível ler o documento. Tente de novo ou preencha manualmente.",
        details: err?.message || "Falha na leitura inteligente",
      });
      return;
    }

    // Salva SEMPRE com validated: false até o corretor conferir no painel
    const docRecord = await prisma.documentRecord.create({
      data: {
        brokerageId: req.user!.brokerageId,
        insuredId: insuredId || undefined,
        docType: extraction.documentType,
        fileName: req.file.originalname,
        fileUrl: `upload:${Date.now()}-${req.file.originalname}`,
        extractedData: JSON.parse(JSON.stringify(extraction.data)),
        validated: false,
      },
    });

    await recordAuditLog({
      brokerageId: req.user!.brokerageId,
      userId: req.user!.userId,
      action: "OCR_DOCUMENT_UPLOADED",
      resource: `DocumentRecord:${docRecord.id}`,
      details: { docType: extraction.documentType, fileName: req.file.originalname, validated: false },
      req,
    });

    res.json({
      success: true,
      documentRecordId: docRecord.id,
      documentType: extraction.documentType,
      confidence: extraction.confidence,
      extractedData: extraction.data,
      installments: extraction.installments || [],
      multicalculoCsvRow: extraction.multicalculoCsvRow,
      validated: false,
      message: "Documento lido com sucesso pela IA. Confirme os dados antes de gerar parcelas ou apólices.",
    });
  }
);

// Validação e confirmação dos dados extraídos pelo corretor
documentsRouter.patch("/:id/validate", requireAuth, async (req: Request, res: Response) => {
  const { id } = req.params;
  const { extractedData, validated } = req.body;

  const doc = await prisma.documentRecord.findFirst({
    where: { id, brokerageId: req.user!.brokerageId },
  });

  if (!doc) {
    res.status(404).json({ error: "Documento não encontrado" });
    return;
  }

  const updated = await prisma.documentRecord.update({
    where: { id },
    data: {
      extractedData: extractedData ? JSON.parse(JSON.stringify(extractedData)) : undefined,
      validated: validated !== undefined ? Boolean(validated) : true,
    },
  });

  await recordAuditLog({
    brokerageId: req.user!.brokerageId,
    userId: req.user!.userId,
    action: "VALIDATE_DOCUMENT_DATA",
    resource: `DocumentRecord:${id}`,
    details: { validated: updated.validated },
    req,
  });

  res.json({
    success: true,
    message: "Dados do documento confirmados pelo corretor.",
    document: updated,
  });
});

// Listagem de documentos analisados
documentsRouter.get("/", requireAuth, async (req: Request, res: Response) => {
  const docs = await prisma.documentRecord.findMany({
    where: { brokerageId: req.user!.brokerageId },
    include: {
      insured: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  res.json(docs);
});
