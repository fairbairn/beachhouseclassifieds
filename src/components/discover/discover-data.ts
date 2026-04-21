export type { DiscoverListing } from "@/lib/discover/discover-types";

export const googleMapsApiKey =
  (import.meta.env.GOOGLE_MAPS_JS_KEY as string | undefined) ??
  (import.meta.env.GOOGLE_MAPS_API_KEY as string | undefined) ??
  (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined);

export const known30AAreas = ["West 30A", "Central 30A", "East 30A"];

export const known30ABeachZones = [
  "Dune Allen Beach",
  "Blue Mountain Beach",
  "Grayton Beach",
  "Seagrove Beach",
  "WaterSound Beach",
  "Seacrest Beach",
  "Rosemary Beach",
  "Santa Rosa Beach",
  "Inlet Beach",
];

export const known30ACommunities = [
  "Watercolor",
  "Seaside",
  "Prominence",
  "WaterSound West Beach",
  "WaterSound Beach",
  "Seacrest",
  "Alys Beach",
  "Rosemary Beach",
];

export const communityBeachAreaMap: Record<string, string> = {
  Seaside: "Seagrove Beach",
  Watercolor: "Seagrove Beach",
  Seacrest: "Seacrest Beach",
  "Rosemary Beach": "Rosemary Beach",
  "Alys Beach": "Alys Beach",
  "WaterSound Beach": "WaterSound Beach",
  "WaterSound West Beach": "WaterSound Beach",
  "Blue Mountain Beach": "Blue Mountain Beach",
  "Kaiya Beach Resort": "Inlet Beach",
};

export const geoByCommunity: Record<string, { lat: number; lng: number }> = {
  Seaside: { lat: 30.3234, lng: -86.1388 },
  Watercolor: { lat: 30.3167, lng: -86.1394 },
  Prominence: { lat: 30.2984, lng: -86.0783 },
  "Blue Mountain Beach": { lat: 30.3374, lng: -86.1966 },
  "WaterSound West Beach": { lat: 30.3013, lng: -86.0958 },
  "WaterSound Beach": { lat: 30.3028, lng: -86.0909 },
  Seacrest: { lat: 30.2787, lng: -86.0345 },
  "Rosemary Beach": { lat: 30.2759, lng: -86.0169 },
  "Alys Beach": { lat: 30.2768, lng: -86.0472 },
};

export const geoByArea: Record<string, { lat: number; lng: number }> = {
  "Dune Allen Beach": { lat: 30.3606, lng: -86.2794 },
  "Gulf Place": { lat: 30.3218, lng: -86.2383 },
  "Blue Mountain Beach": { lat: 30.3341, lng: -86.2142 },
  "Grayton Beach": { lat: 30.3284, lng: -86.1676 },
  "Seagrove Beach": { lat: 30.3131, lng: -86.1245 },
  "Old Seagrove": { lat: 30.3124, lng: -86.1313 },
  "Eastern Lake": { lat: 30.3088, lng: -86.1086 },
  "Seacrest Beach": { lat: 30.2787, lng: -86.0345 },
  Seacrest: { lat: 30.2787, lng: -86.0345 },
  "Alys Beach": { lat: 30.2768, lng: -86.0472 },
  "Rosemary Beach": { lat: 30.2759, lng: -86.0169 },
  "Rosemary / Inlet Beach": { lat: 30.2755, lng: -86.0129 },
  "Inlet Beach": { lat: 30.2752, lng: -86.0088 },
  "Santa Rosa Beach": { lat: 30.396, lng: -86.2288 },
  WaterSound: { lat: 30.3005, lng: -86.0904 },
  "WaterSound Beach": { lat: 30.3028, lng: -86.0909 },
  "WaterSound West Beach": { lat: 30.3013, lng: -86.0958 },
  "WaterSound Bridges": { lat: 30.2991, lng: -86.0664 },
  "WaterSound Origins": { lat: 30.284, lng: -86.0375 },
  "Kaiya Beach Resort": { lat: 30.2754, lng: -86.0108 },
  Seaside: { lat: 30.3234, lng: -86.1388 },
  Watercolor: { lat: 30.3167, lng: -86.1394 },
};

export const geoByRegion: Record<string, { lat: number; lng: number }> = {
  "West 30A": { lat: 30.3385, lng: -86.2114 },
  "Central 30A": { lat: 30.317, lng: -86.1353 },
  "East 30A": { lat: 30.2796, lng: -86.0298 },
};

export const homeHeroBackgroundImage =
  "https://30a.com/wp-content/uploads/2025/08/Alys-Beach-1.jpg";
