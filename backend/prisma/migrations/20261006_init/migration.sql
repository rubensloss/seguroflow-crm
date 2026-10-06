-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('OWNER', 'BROKER', 'ATTENDANT');

-- CreateEnum
CREATE TYPE "InsuranceBranch" AS ENUM ('AUTO', 'RESIDENCIAL', 'VIDA', 'SAUDE', 'EMPRESARIAL', 'TRANSPORTE', 'RURAL', 'OUTROS');

-- CreateEnum
CREATE TYPE "PolicyStatus" AS ENUM ('ACTIVE', 'EXPIRING', 'RENEWED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InstallmentStatus" AS ENUM ('PENDING', 'SENT_D7', 'SENT_D0', 'SENT_D2', 'PAID', 'OVERDUE', 'CLAIMED_PAID');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('OPEN', 'DOCS_COLLECTED', 'FORWARDED_TO_INSURER', 'IN_ANALYSIS', 'APPROVED', 'REJECTED', 'CLOSED');

-- CreateEnum
CREATE TYPE "PipelineStage" AS ENUM ('NOVO', 'COTACAO', 'PROPOSTA', 'EMISSAO', 'POS_VENDA');

-- CreateEnum
CREATE TYPE "RenewalWindow" AS ENUM ('DAYS_60', 'DAYS_30', 'DAYS_15');

-- CreateEnum
CREATE TYPE "RenewalStatus" AS ENUM ('PENDING', 'CONTACTED', 'IN_NEGOTIATION', 'RENEWED', 'LOST');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('CNH', 'CRLV', 'APOLICE');

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('AI_CONTROLLED', 'HUMAN_CONTROLLED', 'CLOSED');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateTable
CREATE TABLE "brokerages" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cnpj" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "whatsappPhoneNumberId" TEXT,
    "whatsappBusinessAccountId" TEXT,
    "whatsappAccessTokenEncrypted" TEXT,
    "whatsappAppSecretEncrypted" TEXT,
    "whatsappVerifyToken" TEXT,
    "agentEnabled" BOOLEAN NOT NULL DEFAULT true,
    "agentTone" TEXT NOT NULL DEFAULT 'PROFISSIONAL_CORDIAL',
    "alertPhone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brokerages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "brokerageId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'BROKER',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insureds" (
    "id" TEXT NOT NULL,
    "brokerageId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cpf" TEXT,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "insureds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policies" (
    "id" TEXT NOT NULL,
    "brokerageId" TEXT NOT NULL,
    "insuredId" TEXT NOT NULL,
    "policyNumber" TEXT NOT NULL,
    "insurerName" TEXT NOT NULL,
    "branch" "InsuranceBranch" NOT NULL DEFAULT 'AUTO',
    "assistance24hPhone" TEXT,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "premiumAmount" DECIMAL(12,2) NOT NULL,
    "commissionPercentage" DECIMAL(5,2),
    "commissionAmount" DECIMAL(12,2),
    "status" "PolicyStatus" NOT NULL DEFAULT 'ACTIVE',
    "itemDescription" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "installments" (
    "id" TEXT NOT NULL,
    "brokerageId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "installmentNumber" INTEGER NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "paymentCode" TEXT,
    "pdfBoletoUrl" TEXT,
    "status" "InstallmentStatus" NOT NULL DEFAULT 'PENDING',
    "paidAt" TIMESTAMP(3),
    "claimedPaidAt" TIMESTAMP(3),
    "claimedPaidNote" TEXT,
    "sentD7At" TIMESTAMP(3),
    "sentD0At" TIMESTAMP(3),
    "sentD2At" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "installments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claims" (
    "id" TEXT NOT NULL,
    "brokerageId" TEXT NOT NULL,
    "insuredId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "incidentType" TEXT NOT NULL,
    "incidentDate" TIMESTAMP(3),
    "incidentLocation" TEXT,
    "description" TEXT NOT NULL,
    "status" "ClaimStatus" NOT NULL DEFAULT 'OPEN',
    "policeReportUrl" TEXT,
    "photos" JSONB,
    "franchiseAmount" DECIMAL(12,2),
    "indemnityAmount" DECIMAL(12,2),
    "workshopName" TEXT,
    "cargoManifestNumber" TEXT,
    "assistanceNotifiedAt" TIMESTAMP(3),
    "brokerNotifiedAt" TIMESTAMP(3),
    "assignedUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pipeline_cards" (
    "id" TEXT NOT NULL,
    "brokerageId" TEXT NOT NULL,
    "insuredId" TEXT,
    "title" TEXT NOT NULL,
    "value" DECIMAL(12,2),
    "stage" "PipelineStage" NOT NULL DEFAULT 'NOVO',
    "stageEnteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "slaHours" INTEGER NOT NULL DEFAULT 24,
    "source" TEXT,
    "notes" TEXT,
    "assignedUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pipeline_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "renewal_tasks" (
    "id" TEXT NOT NULL,
    "brokerageId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "alertWindow" "RenewalWindow" NOT NULL,
    "status" "RenewalStatus" NOT NULL DEFAULT 'PENDING',
    "lostReason" TEXT,
    "assignedUserId" TEXT,
    "lastContactAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "renewal_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_records" (
    "id" TEXT NOT NULL,
    "brokerageId" TEXT NOT NULL,
    "insuredId" TEXT,
    "docType" "DocumentType" NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "extractedData" JSONB NOT NULL,
    "validated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" TEXT NOT NULL,
    "brokerageId" TEXT NOT NULL,
    "insuredId" TEXT,
    "phone" TEXT NOT NULL,
    "status" "ConversationStatus" NOT NULL DEFAULT 'AI_CONTROLLED',
    "humanReason" TEXT,
    "assignedUserId" TEXT,
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "text" TEXT NOT NULL,
    "mediaUrl" TEXT,
    "mediaType" TEXT,
    "externalId" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "brokerageId" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "details" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "brokerages_slug_key" ON "brokerages"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "brokerages_whatsappPhoneNumberId_key" ON "brokerages"("whatsappPhoneNumberId");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_brokerageId_idx" ON "users"("brokerageId");

-- CreateIndex
CREATE INDEX "insureds_brokerageId_idx" ON "insureds"("brokerageId");

-- CreateIndex
CREATE INDEX "insureds_phone_idx" ON "insureds"("phone");

-- CreateIndex
CREATE INDEX "insureds_cpf_idx" ON "insureds"("cpf");

-- CreateIndex
CREATE INDEX "policies_brokerageId_idx" ON "policies"("brokerageId");

-- CreateIndex
CREATE INDEX "policies_insuredId_idx" ON "policies"("insuredId");

-- CreateIndex
CREATE INDEX "policies_policyNumber_idx" ON "policies"("policyNumber");

-- CreateIndex
CREATE INDEX "policies_endDate_idx" ON "policies"("endDate");

-- CreateIndex
CREATE INDEX "installments_brokerageId_idx" ON "installments"("brokerageId");

-- CreateIndex
CREATE INDEX "installments_policyId_idx" ON "installments"("policyId");

-- CreateIndex
CREATE INDEX "installments_dueDate_idx" ON "installments"("dueDate");

-- CreateIndex
CREATE INDEX "installments_status_idx" ON "installments"("status");

-- CreateIndex
CREATE INDEX "claims_brokerageId_idx" ON "claims"("brokerageId");

-- CreateIndex
CREATE INDEX "claims_status_idx" ON "claims"("status");

-- CreateIndex
CREATE INDEX "pipeline_cards_brokerageId_idx" ON "pipeline_cards"("brokerageId");

-- CreateIndex
CREATE INDEX "pipeline_cards_stage_idx" ON "pipeline_cards"("stage");

-- CreateIndex
CREATE INDEX "renewal_tasks_brokerageId_idx" ON "renewal_tasks"("brokerageId");

-- CreateIndex
CREATE INDEX "renewal_tasks_policyId_idx" ON "renewal_tasks"("policyId");

-- CreateIndex
CREATE INDEX "renewal_tasks_status_idx" ON "renewal_tasks"("status");

-- CreateIndex
CREATE INDEX "document_records_brokerageId_idx" ON "document_records"("brokerageId");

-- CreateIndex
CREATE INDEX "conversations_brokerageId_idx" ON "conversations"("brokerageId");

-- CreateIndex
CREATE INDEX "conversations_phone_idx" ON "conversations"("phone");

-- CreateIndex
CREATE INDEX "conversations_assignedUserId_idx" ON "conversations"("assignedUserId");

-- CreateIndex
CREATE INDEX "messages_conversationId_idx" ON "messages"("conversationId");

-- CreateIndex
CREATE INDEX "audit_logs_brokerageId_idx" ON "audit_logs"("brokerageId");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_brokerageId_fkey" FOREIGN KEY ("brokerageId") REFERENCES "brokerages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insureds" ADD CONSTRAINT "insureds_brokerageId_fkey" FOREIGN KEY ("brokerageId") REFERENCES "brokerages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policies" ADD CONSTRAINT "policies_brokerageId_fkey" FOREIGN KEY ("brokerageId") REFERENCES "brokerages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policies" ADD CONSTRAINT "policies_insuredId_fkey" FOREIGN KEY ("insuredId") REFERENCES "insureds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "installments" ADD CONSTRAINT "installments_brokerageId_fkey" FOREIGN KEY ("brokerageId") REFERENCES "brokerages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "installments" ADD CONSTRAINT "installments_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_brokerageId_fkey" FOREIGN KEY ("brokerageId") REFERENCES "brokerages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_insuredId_fkey" FOREIGN KEY ("insuredId") REFERENCES "insureds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipeline_cards" ADD CONSTRAINT "pipeline_cards_brokerageId_fkey" FOREIGN KEY ("brokerageId") REFERENCES "brokerages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipeline_cards" ADD CONSTRAINT "pipeline_cards_insuredId_fkey" FOREIGN KEY ("insuredId") REFERENCES "insureds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipeline_cards" ADD CONSTRAINT "pipeline_cards_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "renewal_tasks" ADD CONSTRAINT "renewal_tasks_brokerageId_fkey" FOREIGN KEY ("brokerageId") REFERENCES "brokerages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "renewal_tasks" ADD CONSTRAINT "renewal_tasks_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "renewal_tasks" ADD CONSTRAINT "renewal_tasks_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_records" ADD CONSTRAINT "document_records_brokerageId_fkey" FOREIGN KEY ("brokerageId") REFERENCES "brokerages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_records" ADD CONSTRAINT "document_records_insuredId_fkey" FOREIGN KEY ("insuredId") REFERENCES "insureds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_brokerageId_fkey" FOREIGN KEY ("brokerageId") REFERENCES "brokerages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_insuredId_fkey" FOREIGN KEY ("insuredId") REFERENCES "insureds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_brokerageId_fkey" FOREIGN KEY ("brokerageId") REFERENCES "brokerages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

