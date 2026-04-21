import {
  queryDiscoverListingDetailRowBySlug,
  type DiscoverListingRecordRow,
} from "@/lib/discover/data-layer/queries/discover-listings-query.server";

export async function queryDiscoverDetailRow(input: {
  slug: string;
}): Promise<DiscoverListingRecordRow | null> {
  return queryDiscoverListingDetailRowBySlug(input);
}
