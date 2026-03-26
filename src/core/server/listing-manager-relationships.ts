import { createHash } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";

import { databaseProvider, pgDb } from "@/core/server/db";
import { listing_manager_relationships } from "@/lib/db/schema-postgres";

type AssignActiveListingManagerInput = {
  listing_id: string;
  manager_id: string;
  relationship_type?: "manager" | "owner" | "co_manager";
  confidence_score?: string | null;
  evidence_source_id?: string | null;
  notes?: string | null;
};

function deriveListingManagerRelationshipId(input: {
  listing_id: string;
  manager_id: string;
  relationship_type: "manager" | "owner" | "co_manager";
  effective_at: string;
}): string {
  const digest = createHash("sha1")
    .update(
      `${input.listing_id}:${input.manager_id}:${input.relationship_type}:${input.effective_at}`,
    )
    .digest("hex")
    .slice(0, 20);

  return `lmr_${digest}`;
}

export async function assign_active_listing_manager_relationship(
  input: AssignActiveListingManagerInput,
): Promise<string> {
  if (databaseProvider !== "postgres" || !pgDb) {
    throw new Error("Postgres provider is required for manager assignments.");
  }

  const relationship_type = input.relationship_type ?? "manager";
  const effective_at = new Date().toISOString();
  const relationship_id = deriveListingManagerRelationshipId({
    listing_id: input.listing_id,
    manager_id: input.manager_id,
    relationship_type,
    effective_at,
  });

  await pgDb.transaction(async (tx) => {
    await tx
      .update(listing_manager_relationships)
      .set({
        is_active: false,
        end_date: effective_at,
        updated_at: effective_at,
      })
      .where(
        and(
          eq(listing_manager_relationships.listing_id, input.listing_id),
          eq(listing_manager_relationships.is_active, true),
          isNull(listing_manager_relationships.end_date),
        ),
      );

    await tx.insert(listing_manager_relationships).values({
      id: relationship_id,
      listing_id: input.listing_id,
      manager_id: input.manager_id,
      relationship_type,
      is_active: true,
      start_date: effective_at,
      end_date: null,
      confidence_score: input.confidence_score ?? null,
      evidence_source_id: input.evidence_source_id ?? null,
      notes: input.notes ?? null,
      created_at: effective_at,
      updated_at: effective_at,
    });
  });

  return relationship_id;
}
