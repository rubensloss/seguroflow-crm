import { Router, Request, Response } from "express";
import multer from "multer";
import { InsuranceBranch } from "@prisma/client";
import { prisma } from "../config/prisma";
import { requireAuth } from "../security/auth";
import { recordAuditLog } from "../services/auditLog";

const upload = multer({ limits: { fileSize: 15 * 1024 * 1024 } });
export const importRouter = Router();

// Importação em lote da carteira de clientes da corretora (Setup / Implantação)
importRouter.post(
  ["/", "/portfolio"],
  requireAuth,
  upload.single("file"),
  async (req: Request, res: Response) => {
    let csvContent = "";

    if (req.file) {
      csvContent = req.file.buffer.toString("utf-8");
    } else if (req.body.csvText) {
      csvContent = String(req.body.csvText);
    } else {
      res.status(400).json({ error: "Envie um arquivo CSV ou texto no campo csvText" });
      return;
    }

    const lines = csvContent
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (lines.length < 2) {
      res.status(400).json({ error: "O CSV deve conter cabeçalho e ao menos uma linha de dados" });
      return;
    }

    const brokerageId = req.user!.brokerageId;
    let importedInsureds = 0;
    let importedPolicies = 0;
    const errors: Array<{ line: number; message: string }> = [];

    // Header esperado: Nome, CPF, Telefone, Email, Seguradora, Apolice, Ramo, VigenciaFim, Premio, SubRamo (opcional)
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(/[,;]/).map((p) => p.trim().replace(/^["']|["']$/g, ""));
      if (parts.length < 5) {
        errors.push({ line: i + 1, message: "Campos insuficientes na linha" });
        continue;
      }

      const [name, rawCpf, rawPhone, email, insurer, policyNumber, rawBranch, rawEndDate, rawPremium, rawSubBranch] = parts;

      if (!name || !rawPhone) {
        errors.push({ line: i + 1, message: "Nome e telefone são obrigatórios" });
        continue;
      }

      const phone = rawPhone.replace(/\D/g, "");
      const cpf = rawCpf ? rawCpf.replace(/\D/g, "") : null;

      try {
        // Localiza ou cria o segurado
        let insured = await prisma.insured.findFirst({
          where: {
            brokerageId,
            OR: [{ phone }, ...(cpf ? [{ cpf }] : [])],
          },
        });

        if (!insured) {
          insured = await prisma.insured.create({
            data: {
              brokerageId,
              name,
              phone,
              cpf,
              email: email || undefined,
            },
          });
          importedInsureds++;
        }

        // Se houver dados de apólice na linha
        if (policyNumber && insurer) {
          const existingPolicy = await prisma.policy.findFirst({
            where: { brokerageId, policyNumber },
          });

          if (!existingPolicy) {
            const endDate = rawEndDate ? new Date(rawEndDate) : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
            const premium = rawPremium ? Number(rawPremium.replace(/[^0-9.]/g, "")) : 1500;

            let branch: InsuranceBranch = InsuranceBranch.AUTO;
            const branchUpper = (rawBranch || "").toUpperCase();
            if (Object.values(InsuranceBranch).includes(branchUpper as any)) {
              branch = branchUpper as InsuranceBranch;
            }

            await prisma.policy.create({
              data: {
                brokerageId,
                insuredId: insured.id,
                policyNumber,
                insurerName: insurer,
                branch,
                subBranch: rawSubBranch ? rawSubBranch.trim() : null,
                startDate: new Date(),
                endDate,
                premiumAmount: isNaN(premium) ? 1500 : premium,
              },
            });
            importedPolicies++;
          }
        }
      } catch (err: any) {
        errors.push({ line: i + 1, message: err.message || "Erro desconhecido" });
      }
    }

    await recordAuditLog({
      brokerageId,
      userId: req.user!.userId,
      action: "IMPORT_PORTFOLIO",
      resource: "PortfolioImport",
      details: { totalLines: lines.length - 1, importedInsureds, importedPolicies, errorsCount: errors.length },
      req,
    });

    res.json({
      success: true,
      totalLinesProcessed: lines.length - 1,
      importedInsureds,
      importedPolicies,
      errors,
    });
  }
);
