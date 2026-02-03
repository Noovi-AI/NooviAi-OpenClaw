import { z } from "zod";

const DmPolicySchema = z.enum(["open", "allowlist", "pairing", "disabled"]);
const GroupPolicySchema = z.enum(["open", "allowlist", "disabled"]);

const WahaGroupConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    requireMention: z.boolean().optional(),
    systemPrompt: z.string().optional(),
    skills: z.array(z.string()).optional(),
  })
  .strict();

const WahaAccountConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    session: z.string(), // WAHA session name (required for accounts)
    name: z.string().optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    dmPolicy: DmPolicySchema.optional(),
    groupPolicy: GroupPolicySchema.optional(),
    mediaMaxMb: z.number().optional(),
    webhookPath: z.string().optional(),
    groups: z.record(z.string(), WahaGroupConfigSchema.optional()).optional(),
  })
  .strict();

export const WahaConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    url: z.string().optional(), // WAHA server URL (e.g., https://connect.clickhype.com.br)
    apiKey: z.string().optional(), // X-Api-Key for WAHA API
    session: z.string().optional(), // Default session name
    name: z.string().optional(),
    webhookPath: z.string().optional(), // Path for receiving webhooks (e.g., /waha/webhook)
    hmacKey: z.string().optional(), // HMAC key for webhook signature validation
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    mediaMaxMb: z.number().optional(),
    accounts: z.record(z.string(), WahaAccountConfigSchema.optional()).optional(),
    groups: z.record(z.string(), WahaGroupConfigSchema.optional()).optional(),
  })
  .strict();

export type WahaConfigSchemaType = z.infer<typeof WahaConfigSchema>;
