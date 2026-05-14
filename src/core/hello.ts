import { z } from "zod";
import { CliUsageError } from "./errors.js";

const helloInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name must not be empty.")
    .max(64, "Name must be 64 characters or fewer.")
    .refine((value) => !value.includes("/"), "Name must not contain '/'.")
    .optional()
    .default("world"),
  uppercase: z.boolean().optional().default(false),
});

export const helloRecordSchema = z.object({
  command: z.literal("hello"),
  name: z.string().min(1),
  message: z.string().min(1),
  createdAt: z.string().datetime(),
});

export type HelloInput = z.input<typeof helloInputSchema>;
export type HelloRecord = z.infer<typeof helloRecordSchema>;

export function createHelloRecord(input: HelloInput): HelloRecord {
  const parsed = helloInputSchema.safeParse(input);

  if (!parsed.success) {
    throw new CliUsageError(parsed.error.issues[0]?.message ?? "Invalid hello input.");
  }

  const baseMessage = `Hello, ${parsed.data.name}!`;
  const message = parsed.data.uppercase ? baseMessage.toUpperCase() : baseMessage;

  return {
    command: "hello",
    name: parsed.data.name,
    message,
    createdAt: new Date().toISOString(),
  };
}
