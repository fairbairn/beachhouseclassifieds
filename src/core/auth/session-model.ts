import { z } from "zod";

export const appSessionSchema = z.object({
  user: z.object({
    id: z.string().nullable().optional().catch(null),
    name: z.string().nullable().catch(null),
    timeZone: z.string().nullable().catch(null),
  }),
});

export type AppSession = z.infer<typeof appSessionSchema>;

export function toAppSession(session: unknown): AppSession | null {
  const parsed = appSessionSchema.safeParse(session);
  return parsed.success ? parsed.data : null;
}
