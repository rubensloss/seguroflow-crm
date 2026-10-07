import { Router, Request, Response } from "express";
import { z } from "zod";
import { InsuranceBranch, PolicyStatus, PolicyItemType, PolicyItemStatus } from "@prisma/client";
import { prisma } from "../config/prisma";
import { requireAuth } from "../security/auth";
import { recordAuditLog } from "../services/auditLog";

export const policiesRouter = Router();

const policySchema = z.object({
  insuredId: z.string().min(1, "Segurado é obrigatório"),
  policyNumber: z.string().min(1, "Número da apólice é obrigatório"),
  insurerName: z.string().min(1, "Seguradora é obrigatória"),
  branch: z.nativeEnum(InsuranceBranch).default(InsuranceBranch.AUTO),
  subBranch: z.string().optional(),
  assistance24hPhone: z.string().optional(),
  startDate: z.string(),
  endDate: z.string(),
  premiumAmount: z.number().positive("Valor do prêmio deve ser positivo"),
  itemDescription: z.string().optional(),
  installmentsCount: z.number().int().min(1).max(12).default(1),
  firstDueDate: z.string().optional(),
});

const policyItemSchema = z.object({
  type: z.nativeEnum(PolicyItemType).default(PolicyItemType.VEICULO),
  plate: z.string().optional(),
  chassis: z.string().optional(),
  makeModel: z.string().optional(),
  year: z.number().int().optional(),
  identification: z.string().optional(),
  status: z.nativeEnum(PolicyItemStatus).default(PolicyItemStatus.ACTIVE),
  inclusionDate: z.string().optional(),
  exclusionDate: z.string().optional(),
});

// Listagem de apólices com filtros (status, ramo, sub-ramo, busca livre)
policiesRouter.get("/", requireAuth, async (req: Request, res: Response) => {
  const { status, branch, subBranch, q } = req.query;
  const brokerageId = req.user!.brokerageId;

  const whereClause: any = { brokerageId };

  if (status) whereClause.status = status as PolicyStatus;
  if (branch) whereClause.branch = branch as InsuranceBranch;
  if (subBranch) whereClause.subBranch = String(subBranch);
  if (q) {
    whereClause.OR = [
      { policyNumber: { contains: String(q) } },
      { insurerName: { contains: String(q), mode: "insensitive" } },
      { insured: { name: { contains: String(q), mode: "insensitive" } } },
      { itemDescription: { contains: String(q), mode: "insensitive" } },
      { subBranch: { contains: String(q), mode: "insensitive" } },
      { items: { some: { plate: { contains: String(q), mode: "insensitive" } } } },
    ];
  }

  const policies = await prisma.policy.findMany({
    where: whereClause,
    include: {
      insured: { select: { id: true, name: true, phone: true, cpf: true } },
      installments: { orderBy: { installmentNumber: "asc" } },
      items: { where: { status: "ACTIVE" } },
    },
    orderBy: { endDate: "asc" },
  });

  res.json(policies);
});

// Busca global por placa no painel inteiro (Frota e apólices individuais)
policiesRouter.get("/search-by-plate", requireAuth, async (req: Request, res: Response) => {
  const brokerageId = req.user!.brokerageId;
  const plateParam = String(req.query.plate || req.query.q || "").trim();

  if (!plateParam) {
    res.status(400).json({ error: "Informe a placa para busca" });
    return;
  }

  const cleanPlate = plateParam.toUpperCase().replace(/[^A-Z0-9]/g, "");

  // 1. Busca nos itens específicos de frota (PolicyItem)
  const items = await prisma.policyItem.findMany({
    where: {
      brokerageId,
      plate: { contains: cleanPlate, mode: "insensitive" },
    },
    include: {
      policy: {
        include: {
          insured: { select: { id: true, name: true, phone: true, cpf: true } },
        },
      },
    },
  });

  // 2. Busca na descrição da apólice (itemDescription)
  const policiesByDesc = await prisma.policy.findMany({
    where: {
      brokerageId,
      itemDescription: { contains: cleanPlate, mode: "insensitive" },
    },
    include: {
      insured: { select: { id: true, name: true, phone: true, cpf: true } },
    },
  });

  res.json({
    query: plateParam,
    cleanPlate,
    items: items.map((it) => ({
      id: it.id,
      type: it.type,
      plate: it.plate,
      chassis: it.chassis,
      makeModel: it.makeModel,
      year: it.year,
      identification: it.identification,
      status: it.status,
      policyId: it.policy.id,
      policyNumber: it.policy.policyNumber,
      insurerName: it.policy.insurerName,
      branch: it.policy.branch,
      subBranch: it.policy.subBranch,
      policyStatus: it.policy.status,
      endDate: it.policy.endDate,
      insured: it.policy.insured,
    })),
    policiesByDescription: policiesByDesc.map((p) => ({
      id: p.id,
      policyNumber: p.policyNumber,
      insurerName: p.insurerName,
      branch: p.branch,
      subBranch: p.subBranch,
      status: p.status,
      itemDescription: p.itemDescription,
      insured: p.insured,
    })),
    totalFound: items.length + policiesByDesc.length,
  });
});

// Detalhes da apólice (com itens de frota, parcelas, sinistros e renovações)
policiesRouter.get("/:id", requireAuth, async (req: Request, res: Response) => {
  const policy = await prisma.policy.findFirst({
    where: { id: req.params.id, brokerageId: req.user!.brokerageId },
    include: {
      insured: true,
      installments: { orderBy: { installmentNumber: "asc" } },
      claims: {
        include: {
          policyItem: true,
        },
      },
      renewals: true,
      items: { orderBy: { createdAt: "asc" } },
    },
  });

  if (!policy) {
    res.status(404).json({ error: "Apólice não encontrada" });
    return;
  }

  res.json(policy);
});

// Atualização de apólice (inclui sub-ramo)
policiesRouter.patch("/:id", requireAuth, async (req: Request, res: Response) => {
  const {
    policyNumber,
    insurerName,
    branch,
    subBranch,
    assistance24hPhone,
    startDate,
    endDate,
    premiumAmount,
    itemDescription,
    status,
  } = req.body;

  const policy = await prisma.policy.findFirst({
    where: { id: req.params.id, brokerageId: req.user!.brokerageId },
  });

  if (!policy) {
    res.status(404).json({ error: "Apólice não encontrada" });
    return;
  }

  const updated = await prisma.policy.update({
    where: { id: policy.id },
    data: {
      policyNumber: policyNumber || undefined,
      insurerName: insurerName || undefined,
      branch: branch || undefined,
      subBranch: subBranch !== undefined ? subBranch : undefined,
      assistance24hPhone: assistance24hPhone !== undefined ? assistance24hPhone : undefined,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      premiumAmount: premiumAmount !== undefined ? Number(premiumAmount) : undefined,
      itemDescription: itemDescription !== undefined ? itemDescription : undefined,
      status: status || undefined,
    },
  });

  await recordAuditLog({
    brokerageId: req.user!.brokerageId,
    userId: req.user!.userId,
    action: "UPDATE_POLICY",
    resource: `Policy:${updated.id}`,
    req,
  });

  res.json(updated);
});

// Criação manual de apólice e geração de parcelas
policiesRouter.post("/", requireAuth, async (req: Request, res: Response) => {
  const data = policySchema.parse(req.body);
  const brokerageId = req.user!.brokerageId;

  const start = new Date(data.startDate);
  const end = new Date(data.endDate);
  const firstDue = data.firstDueDate ? new Date(data.firstDueDate) : new Date(start);

  const installmentAmount = (data.premiumAmount / data.installmentsCount).toFixed(2);

  const result = await prisma.$transaction(async (tx) => {
    const policy = await tx.policy.create({
      data: {
        brokerageId,
        insuredId: data.insuredId,
        policyNumber: data.policyNumber,
        insurerName: data.insurerName,
        branch: data.branch,
        subBranch: data.subBranch || null,
        assistance24hPhone: data.assistance24hPhone && data.assistance24hPhone.trim().length > 0 ? data.assistance24hPhone.trim() : null,
        startDate: start,
        endDate: end,
        premiumAmount: data.premiumAmount,
        itemDescription: data.itemDescription,
      },
    });

    // Cria as parcelas
    const installmentsData = [];
    for (let i = 1; i <= data.installmentsCount; i++) {
      const due = new Date(firstDue);
      due.setMonth(due.getMonth() + (i - 1));

      installmentsData.push({
        brokerageId,
        policyId: policy.id,
        installmentNumber: i,
        dueDate: due,
        amount: Number(installmentAmount),
        status: "PENDING" as const,
      });
    }

    await tx.installment.createMany({ data: installmentsData });

    return policy;
  });

  await recordAuditLog({
    brokerageId,
    userId: req.user!.userId,
    action: "CREATE_POLICY",
    resource: `Policy:${result.id}`,
    req,
  });

  res.status(201).json(result);
});

// =============================================================================
// GESTÃO DE ITENS DE FROTA (PolicyItem)
// =============================================================================

// Listar itens de frota da apólice
policiesRouter.get("/:id/items", requireAuth, async (req: Request, res: Response) => {
  const brokerageId = req.user!.brokerageId;
  const policy = await prisma.policy.findFirst({
    where: { id: req.params.id, brokerageId },
  });

  if (!policy) {
    res.status(404).json({ error: "Apólice não encontrada" });
    return;
  }

  const items = await prisma.policyItem.findMany({
    where: { policyId: policy.id, brokerageId },
    orderBy: { createdAt: "asc" },
  });

  res.json(items);
});

// Cadastrar novo item na frota da apólice
policiesRouter.post("/:id/items", requireAuth, async (req: Request, res: Response) => {
  const brokerageId = req.user!.brokerageId;
  const policy = await prisma.policy.findFirst({
    where: { id: req.params.id, brokerageId },
  });

  if (!policy) {
    res.status(404).json({ error: "Apólice não encontrada" });
    return;
  }

  const data = policyItemSchema.parse(req.body);
  const cleanPlate = data.plate ? data.plate.toUpperCase().replace(/[^A-Z0-9]/g, "") : null;

  const item = await prisma.policyItem.create({
    data: {
      brokerageId,
      policyId: policy.id,
      type: data.type,
      plate: cleanPlate,
      chassis: data.chassis ? data.chassis.toUpperCase().trim() : null,
      makeModel: data.makeModel ? data.makeModel.trim() : null,
      year: data.year || null,
      identification: data.identification ? data.identification.trim() : null,
      status: data.status,
      inclusionDate: data.inclusionDate ? new Date(data.inclusionDate) : new Date(),
      exclusionDate: data.exclusionDate ? new Date(data.exclusionDate) : null,
    },
  });

  await recordAuditLog({
    brokerageId,
    userId: req.user!.userId,
    action: "CREATE_POLICY_ITEM",
    resource: `PolicyItem:${item.id}`,
    req,
  });

  res.status(201).json(item);
});

// Atualizar item da frota (inclui exclusão por endosso)
policiesRouter.patch("/:id/items/:itemId", requireAuth, async (req: Request, res: Response) => {
  const brokerageId = req.user!.brokerageId;
  const item = await prisma.policyItem.findFirst({
    where: { id: req.params.itemId, policyId: req.params.id, brokerageId },
  });

  if (!item) {
    res.status(404).json({ error: "Item de frota não encontrado" });
    return;
  }

  const { type, plate, chassis, makeModel, year, identification, status, inclusionDate, exclusionDate } = req.body;
  const cleanPlate = plate !== undefined ? (plate ? String(plate).toUpperCase().replace(/[^A-Z0-9]/g, "") : null) : undefined;

  const updated = await prisma.policyItem.update({
    where: { id: item.id },
    data: {
      type: type || undefined,
      plate: cleanPlate,
      chassis: chassis !== undefined ? (chassis ? String(chassis).toUpperCase().trim() : null) : undefined,
      makeModel: makeModel !== undefined ? (makeModel ? String(makeModel).trim() : null) : undefined,
      year: year !== undefined ? (year ? Number(year) : null) : undefined,
      identification: identification !== undefined ? (identification ? String(identification).trim() : null) : undefined,
      status: status || undefined,
      inclusionDate: inclusionDate ? new Date(inclusionDate) : undefined,
      exclusionDate: exclusionDate !== undefined ? (exclusionDate ? new Date(exclusionDate) : null) : undefined,
    },
  });

  await recordAuditLog({
    brokerageId,
    userId: req.user!.userId,
    action: "UPDATE_POLICY_ITEM",
    resource: `PolicyItem:${updated.id}`,
    req,
  });

  res.json(updated);
});

// Remover item da frota
policiesRouter.delete("/:id/items/:itemId", requireAuth, async (req: Request, res: Response) => {
  const brokerageId = req.user!.brokerageId;
  const item = await prisma.policyItem.findFirst({
    where: { id: req.params.itemId, policyId: req.params.id, brokerageId },
  });

  if (!item) {
    res.status(404).json({ error: "Item de frota não encontrado" });
    return;
  }

  await prisma.policyItem.delete({ where: { id: item.id } });

  await recordAuditLog({
    brokerageId,
    userId: req.user!.userId,
    action: "DELETE_POLICY_ITEM",
    resource: `PolicyItem:${item.id}`,
    req,
  });

  res.json({ success: true, message: "Item removido com sucesso da frota" });
});

// Importação em lote de veículos de frota para a apólice via CSV
policiesRouter.post("/:id/items/import", requireAuth, async (req: Request, res: Response) => {
  const brokerageId = req.user!.brokerageId;
  const policy = await prisma.policy.findFirst({
    where: { id: req.params.id, brokerageId },
  });

  if (!policy) {
    res.status(404).json({ error: "Apólice não encontrada" });
    return;
  }

  const csvText = String(req.body.csvText || "");
  const lines = csvText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);

  if (lines.length === 0) {
    res.status(400).json({ error: "Texto CSV vazio" });
    return;
  }

  let imported = 0;
  const startIndex = lines[0].toLowerCase().includes("placa") ? 1 : 0;

  for (let i = startIndex; i < lines.length; i++) {
    const parts = lines[i].split(/[,;]/).map((p) => p.trim().replace(/^["']|["']$/g, ""));
    if (parts.length === 0 || !parts[0]) continue;

    // Formato esperado: Placa, Chassi, Modelo, Ano, Identificacao, Tipo
    const [rawPlate, rawChassis, rawModel, rawYear, rawIdent, rawType] = parts;
    const cleanPlate = rawPlate ? rawPlate.toUpperCase().replace(/[^A-Z0-9]/g, "") : null;

    let type: PolicyItemType = PolicyItemType.VEICULO;
    const upperType = (rawType || "").toUpperCase();
    if (upperType.includes("CARRETA")) type = PolicyItemType.CARRETA;
    else if (upperType.includes("EMBARC") || upperType.includes("CASCO")) type = PolicyItemType.EMBARCACAO_CASCO;
    else if (upperType.includes("OUTRO")) type = PolicyItemType.OUTRO;

    await prisma.policyItem.create({
      data: {
        brokerageId,
        policyId: policy.id,
        type,
        plate: cleanPlate,
        chassis: rawChassis ? rawChassis.toUpperCase().trim() : null,
        makeModel: rawModel ? rawModel.trim() : null,
        year: rawYear ? parseInt(rawYear.replace(/\D/g, ""), 10) || null : null,
        identification: rawIdent ? rawIdent.trim() : null,
        status: PolicyItemStatus.ACTIVE,
      },
    });
    imported++;
  }

  res.json({
    success: true,
    imported,
    message: `${imported} veículos/itens importados para a frota da apólice.`,
  });
});

// Criação automática de Apólice + Parcelas a partir do OCR de Proposta (Sem digitação manual!)
policiesRouter.post("/from-proposal-ocr", requireAuth, async (req: Request, res: Response) => {
  const brokerageId = req.user!.brokerageId;
  const {
    insurerName,
    policyNumber,
    branch = InsuranceBranch.AUTO,
    subBranch,
    insuredName,
    insuredCpf,
    insuredPhone,
    insuredEmail,
    startDate,
    endDate,
    premiumAmount,
    commissionPercentage = 15,
    assistance24hPhone,
    itemDescription,
    installments,
  } = req.body;

  if (!insurerName || !insuredName || !insuredPhone || !premiumAmount) {
    res.status(400).json({ error: "Dados mínimos da proposta ausentes (Seguradora, Nome, Telefone ou Prêmio)" });
    return;
  }

  const premNum = Number(premiumAmount);
  const commPct = Number(commissionPercentage) || 15;
  const commAmount = (premNum * commPct) / 100;

  const result = await prisma.$transaction(async (tx) => {
    // 1. Localiza ou cria Segurado
    let insured = await tx.insured.findFirst({
      where: {
        brokerageId,
        OR: [
          insuredCpf ? { cpf: insuredCpf } : { phone: insuredPhone },
          { phone: insuredPhone },
        ],
      },
    });

    if (!insured) {
      insured = await tx.insured.create({
        data: {
          brokerageId,
          name: insuredName,
          phone: insuredPhone,
          cpf: insuredCpf || undefined,
          email: insuredEmail || undefined,
        },
      });
    }

    // 2. Cria Apólice
    const start = startDate ? new Date(startDate) : new Date();
    const end = endDate ? new Date(endDate) : new Date(start.getTime() + 365 * 24 * 60 * 60 * 1000);

    const policy = await tx.policy.create({
      data: {
        brokerageId,
        insuredId: insured.id,
        policyNumber: policyNumber || `PROP-${Date.now().toString().slice(-6)}`,
        insurerName,
        branch: branch as InsuranceBranch,
        subBranch: subBranch || null,
        startDate: start,
        endDate: end,
        premiumAmount: premNum,
        commissionPercentage: commPct,
        commissionAmount: commAmount,
        assistance24hPhone: assistance24hPhone && assistance24hPhone.trim().length > 0 ? assistance24hPhone.trim() : null,
        itemDescription: itemDescription || "Item segurado",
        status: "ACTIVE",
      },
    });

    // 3. Cria as parcelas extraídas com as datas exatas
    const installmentsToInsert = [];
    if (Array.isArray(installments) && installments.length > 0) {
      for (const inst of installments) {
        installmentsToInsert.push({
          brokerageId,
          policyId: policy.id,
          installmentNumber: Number(inst.installmentNumber) || 1,
          dueDate: new Date(inst.dueDate),
          amount: Number(inst.amount) || premNum / installments.length,
          paymentCode: inst.paymentCode || undefined,
          status: "PENDING" as const,
        });
      }
    } else {
      installmentsToInsert.push({
        brokerageId,
        policyId: policy.id,
        installmentNumber: 1,
        dueDate: new Date(start.getTime() + 5 * 24 * 60 * 60 * 1000),
        amount: premNum,
        status: "PENDING" as const,
      });
    }

    await tx.installment.createMany({ data: installmentsToInsert });

    return { policy, insured, installmentsCount: installmentsToInsert.length };
  });

  await recordAuditLog({
    brokerageId,
    userId: req.user!.userId,
    action: "CREATE_POLICY_FROM_PROPOSAL_OCR",
    resource: `Policy:${result.policy.id}`,
    req,
  });

  res.status(201).json({
    success: true,
    message: `Apólice e ${result.installmentsCount} parcelas geradas com sucesso sem digitação manual!`,
    policy: result.policy,
    insured: result.insured,
  });
});
