# SeguroFlow — Backend Oficial de Produção
**Uma solução Creative Always** ([creativealways.com.br/solucoes](https://creativealways.com.br/solucoes/))

Backend de orquestração multi-tenant para corretoras de seguros: CRM, Atendimento oficial via Meta WhatsApp Cloud API, Triagem de Sinistros, Régua de Cobrança Preventiva (D-7, D-0, D+2), Esteira de Renovações (60d, 30d, 15d) e Leitura Inteligente de Documentos (CNH/CRLV/Apólice) com Visão Computacional.

---

## 🛠️ Stack Tecnológica
* **Runtime:** Node.js v20+ / TypeScript (ES2022)
* **Framework:** Express + Helmet + CORS + Zod
* **Banco de Dados:** PostgreSQL com Prisma ORM
* **Segurança:** AES-256-GCM para credenciais de terceiros, Bcrypt e JWT multi-tenant
* **WhatsApp Oficial:** WhatsApp Business Platform (Cloud API) da Meta com validação de assinatura `X-Hub-Signature-256` isolada por tenant
* **Inteligência Artificial:** Anthropic Claude 3.5 Sonnet (tool use e OCR visual) + OpenAI Whisper (transcrição de áudio)

---

## 🚀 Como Executar Localmente

### 1. Instalar Dependências
```bash
cd backend
npm install
```

### 2. Configurar Variáveis de Ambiente
Copie o arquivo `.env.example` para `.env` e preencha as chaves:
```bash
cp .env.example .env
```

### 3. Gerar Prisma Client & Migrações
```bash
npm run prisma:generate
npm run prisma:migrate
```

### 4. Rodar Testes Automatizados
```bash
npm test
```

### 5. Iniciar em Modo de Desenvolvimento
```bash
npm run dev
```
O servidor iniciará em `http://localhost:3001`.

---

## 📡 Webhook da Meta WhatsApp Cloud API
* **Endpoint de Handshake (GET):** `https://seu-dominio.up.railway.app/api/webhooks/whatsapp`
* **Endpoint de Eventos (POST):** `https://seu-dominio.up.railway.app/api/webhooks/whatsapp`
* **Campos Assinados no Meta Developers:** `messages`

---

## 🛡️ Conformidade LGPD
* Isolamento estrito de dados por `brokerageId` em todas as consultas.
* Criptografia de chaves sensíveis em repouso (`AES-256-GCM`).
* Registro de auditoria (`AuditLog`) para operações com dados de segurados.
* Rotas de portabilidade (`GET /api/privacy/export`) e direito ao esquecimento (`DELETE /api/privacy/insured/:id`).
