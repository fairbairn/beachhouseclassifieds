import { databaseProvider } from "@/core/server/db";

type AssignActiveListingManagerInput = {
  listing_id: string;
  manager_id: string;
  relationship_type?: "manager" | "owner" | "co_manager";
  confidence_score?: string | null;
  evidence_source_id?: string | null;
  notes?: string | null;
};

export async function assign_active_listing_manager_relationship(
  input: AssignActiveListingManagerInput,
): Promise<string> {
  if (databaseProvider !== "postgres") {
    throw new Error("Postgres provider is required for manager assignments.");
  }

  void input;
  throw new Error(
    "listing_manager_relationships is deprecated in the new baseline schema.",
  );
}
