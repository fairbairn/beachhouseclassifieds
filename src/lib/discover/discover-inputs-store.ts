import { Store } from "@tanstack/store";

export type DiscoverInputsState = {
  sortOption:
    | "recommended"
    | "price-low"
    | "price-high"
    | "sleeps-high"
    | "beach-pool-first";
  locationQuery: string;
  minSleeps: number;
  minBedrooms: number;
  minBathrooms: number;
  selectedAreas: string[];
  selectedBeaches: string[];
  selectedCommunities: string[];
  selectedFeatures: string[];
  minKingBeds: number;
  minQueenBeds: number;
  minBunkBeds: number;
};

export function normalizeDiscoverInputsState(
  input: DiscoverInputsState,
): DiscoverInputsState {
  return {
    sortOption: input.sortOption,
    locationQuery: input.locationQuery.trim(),
    minSleeps: Math.max(0, Math.floor(input.minSleeps)),
    minBedrooms: Math.max(0, Math.floor(input.minBedrooms)),
    minBathrooms: Math.max(0, Math.floor(input.minBathrooms)),
    selectedAreas: [...input.selectedAreas].sort(),
    selectedBeaches: [...input.selectedBeaches].sort(),
    selectedCommunities: [...input.selectedCommunities].sort(),
    selectedFeatures: [...input.selectedFeatures].sort(),
    minKingBeds: Math.max(0, Math.floor(input.minKingBeds)),
    minQueenBeds: Math.max(0, Math.floor(input.minQueenBeds)),
    minBunkBeds: Math.max(0, Math.floor(input.minBunkBeds)),
  };
}

export function buildDiscoverInputsSignature(
  input: DiscoverInputsState,
): string {
  const normalized = normalizeDiscoverInputsState(input);

  return JSON.stringify([
    normalized.sortOption,
    normalized.locationQuery.toLowerCase(),
    normalized.minSleeps,
    normalized.minBedrooms,
    normalized.minBathrooms,
    normalized.selectedAreas,
    normalized.selectedBeaches,
    normalized.selectedCommunities,
    normalized.selectedFeatures,
    normalized.minKingBeds,
    normalized.minQueenBeds,
    normalized.minBunkBeds,
  ]);
}

export function createDiscoverInputsStore(
  initial?: Partial<DiscoverInputsState>,
) {
  const state = normalizeDiscoverInputsState({
    sortOption: initial?.sortOption ?? "recommended",
    locationQuery: initial?.locationQuery ?? "",
    minSleeps: initial?.minSleeps ?? 0,
    minBedrooms: initial?.minBedrooms ?? 0,
    minBathrooms: initial?.minBathrooms ?? 0,
    selectedAreas: initial?.selectedAreas ?? [],
    selectedBeaches: initial?.selectedBeaches ?? [],
    selectedCommunities: initial?.selectedCommunities ?? [],
    selectedFeatures: initial?.selectedFeatures ?? [],
    minKingBeds: initial?.minKingBeds ?? 0,
    minQueenBeds: initial?.minQueenBeds ?? 0,
    minBunkBeds: initial?.minBunkBeds ?? 0,
  });

  return new Store<DiscoverInputsState>(state);
}
