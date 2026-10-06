import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(3001),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DATABASE_URL: z.string().default("postgresql://postgres:postgres@localhost:5432/seguroflow?schema=public"),
  JWT_SECRET: z.string().default("seguroflow_super_secret_jwt_key_creative_always_2026_change_in_prod"),
  JWT_EXPIRES_IN: z.string().default("7d"),
  ENCRYPTION_KEY: z.string().min(16).default("creativealways_seguroflow_key_32b"),
  ANTHROPIC_API_KEY: z.string().optional().default(""),
  OPENAI_API_KEY: z.string().optional().default(""),
  GEMINI_API_KEY: z.string().optional().default(""),
  WHATSAPP_GRAPH_API_VERSION: z.string().default("v21.0"),
  CORS_ORIGIN: z.string().default("*"),
});

export const env = envSchema.parse(process.env);
