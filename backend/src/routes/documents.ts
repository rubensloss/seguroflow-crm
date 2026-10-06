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

    const extraction = await extractDocumentWithAi(
      req.file.buffer,
      req.file.mimetype,
      docTypeHint
    );

    const docRecord = await prisma.documentRecord.create({
      data: {
        brokerageId: req.user!.brokerageId,
        insuredId: insuredId || undefined,
        docType: extraction.documentType,
        fileName: req.file.originalname,
        fileUrl: `upload:${Date.now()}-${req.file.originalname}`,
        extractedData: JSON.parse(JSON.stringify(extraction.data)),
        validated: true,
      },
    });

    await recordAuditLog({
      brokerageId: req.user!.brokerageId,
      userId: req.user!.userId,
      action: "OCR_DOCUMENT",
      resource: `DocumentRecord:${docRecord.id}`,
      details: { docType: extraction.documentType, fileName: req.file.originalname },
      req,
    });

    res.json({
      success: true,
      documentRecordId: docRecord.id,
      documentType: extraction.documentType,
      confidence: extraction.confidence,
      extractedData: extraction.data,
      multicalculoCsvRow: extraction.multicalculoCsvRow,
    });
  }
);

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
