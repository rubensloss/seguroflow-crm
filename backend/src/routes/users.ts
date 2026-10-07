import { Router, Request, Response } from "express";
import { prisma } from "../config/prisma";
import { requireAuth, requireRoles } from "../security/auth";
import { recordAuditLog } from "../services/auditLog";

export const usersRouter = Router();

/**
 * Listagem de usuários / corretores da corretora
 */
usersRouter.get("/", requireAuth, async (req: Request, res: Response) => {
  const users = await prisma.user.findMany({
    where: { brokerageId: req.user!.brokerageId },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      active: true,
      createdAt: true,
    },
    orderBy: { name: "asc" },
  });

  res.json(users);
});

/**
 * Resumo prévio de transferência de carteira (quantidades a transferir)
 * Apenas OWNER pode visualizar
 */
usersRouter.get(
  "/:id/transfer-summary",
  requireAuth,
  requireRoles(["OWNER"]),
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const brokerageId = req.user!.brokerageId;

    const sourceUser = await prisma.user.findFirst({
      where: { id, brokerageId },
      select: { id: true, name: true, email: true, role: true, active: true },
    });

    if (!sourceUser) {
      res.status(404).json({ error: "Usuário de origem não encontrado na sua corretora." });
      return;
    }

    const [conversationsCount, renewalsCount, pipelineCardsCount, claimsCount, policiesCount] =
      await Promise.all([
        prisma.conversation.count({
          where: { brokerageId, assignedUserId: id },
        }),
        prisma.renewalTask.count({
          where: { brokerageId, assignedUserId: id, status: "PENDING" },
        }),
        prisma.pipelineCard.count({
          where: { brokerageId, assignedUserId: id, stage: { not: "POS_VENDA" } },
        }),
        prisma.claim.count({
          where: { brokerageId, assignedUserId: id, status: { not: "CLOSED" } },
        }),
        prisma.policy.count({
          where: { brokerageId, assignedUserId: id, status: "ACTIVE" },
        }),
      ]);

    res.json({
      sourceUser,
      fromUser: sourceUser,
      summary: {
        conversationsCount,
        renewalTasksCount: renewalsCount,
        pipelineCardsCount,
        claimsCount,
        policiesCount,
      },
      counts: {
        conversations: conversationsCount,
        renewals: renewalsCount,
        pipelineCards: pipelineCardsCount,
        claims: claimsCount,
        policies: policiesCount,
        total:
          conversationsCount + renewalsCount + pipelineCardsCount + claimsCount + policiesCount,
      },
    });
  }
);

/**
 * Transferência atômica de carteira entre corretores
 * Apenas OWNER pode executar. Protegido rigorosamente contra vazamento entre corretoras.
 */
usersRouter.post(
  "/:id/transfer-portfolio",
  requireAuth,
  requireRoles(["OWNER"]),
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const { toUserId, deactivate } = req.body;
    const brokerageId = req.user!.brokerageId;

    if (!toUserId || typeof toUserId !== "string") {
      res.status(400).json({ error: "ID do corretor destinatário (toUserId) é obrigatório." });
      return;
    }

    if (id === toUserId) {
      res.status(400).json({ error: "O corretor destinatário deve ser diferente do corretor de origem." });
      return;
    }

    // 1. Validação estrita multi-tenant: ambos os usuários devem pertencer à MESMA corretora
    const [sourceUser, targetUser] = await Promise.all([
      prisma.user.findFirst({ where: { id, brokerageId } }),
      prisma.user.findFirst({ where: { id: toUserId, brokerageId } }),
    ]);

    if (!sourceUser) {
      res.status(404).json({ error: "Corretor de origem não encontrado na sua corretora." });
      return;
    }

    if (!targetUser) {
      res.status(404).json({ error: "Corretor de destino não encontrado na sua corretora." });
      return;
    }

    if (!targetUser.active) {
      res.status(400).json({ error: "Não é possível transferir a carteira para um usuário inativo." });
      return;
    }

    // 2. Transferência atômica em transação Prisma
    const result = await prisma.$transaction(async (tx) => {
      const conversations = await tx.conversation.updateMany({
        where: { brokerageId, assignedUserId: id },
        data: { assignedUserId: toUserId },
      });

      const renewals = await tx.renewalTask.updateMany({
        where: { brokerageId, assignedUserId: id, status: "PENDING" },
        data: { assignedUserId: toUserId },
      });

      const pipelineCards = await tx.pipelineCard.updateMany({
        where: { brokerageId, assignedUserId: id, stage: { not: "POS_VENDA" } },
        data: { assignedUserId: toUserId },
      });

      const claims = await tx.claim.updateMany({
        where: { brokerageId, assignedUserId: id, status: { not: "CLOSED" } },
        data: { assignedUserId: toUserId },
      });

      const policies = await tx.policy.updateMany({
        where: { brokerageId, assignedUserId: id },
        data: { assignedUserId: toUserId },
      });

      let userDeactivated = false;
      if (deactivate === true) {
        await tx.user.update({
          where: { id },
          data: { active: false },
        });
        userDeactivated = true;
      }

      return {
        conversationsTransferred: conversations.count,
        renewalsTransferred: renewals.count,
        pipelineCardsTransferred: pipelineCards.count,
        claimsTransferred: claims.count,
        policiesTransferred: policies.count,
        userDeactivated,
      };
    });

    // 3. Auditoria LGPD detalhada
    await recordAuditLog({
      brokerageId,
      userId: req.user!.userId,
      action: "TRANSFER_USER_PORTFOLIO",
      resource: `User:${id}->User:${toUserId}`,
      details: {
        fromUserName: sourceUser.name,
        toUserName: targetUser.name,
        result,
      },
      req,
    });

    res.json({
      success: true,
      message: `Carteira transferida com sucesso de ${sourceUser.name} para ${targetUser.name}!`,
      fromUser: { id: sourceUser.id, name: sourceUser.name },
      toUser: { id: targetUser.id, name: targetUser.name },
      transferred: result,
    });
  }
);
