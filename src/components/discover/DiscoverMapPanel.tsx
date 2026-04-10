import { importLibrary, setOptions } from "@googlemaps/js-api-loader";
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { googleMapsApiKey } from "@/components/discover/discover-data";

type LatLng = { lat: number; lng: number };
type GoogleMapInstance = {
  panTo: (center: LatLng) => void;
  setZoom: (zoom: number) => void;
  getZoom: () => number | undefined;
  setMapTypeId: (type: "roadmap" | "satellite") => void;
  addListener: (
    eventName: "zoom_changed",
    handler: () => void,
  ) => { remove: () => void };
};
type GoogleMapsEventListener = { remove: () => void };
type GoogleMarkerInstance = {
  setPosition: (center: LatLng) => void;
  setMap: (map: GoogleMapInstance | null) => void;
  setVisible: (visible: boolean) => void;
  setIcon: (icon: Record<string, unknown> | string) => void;
  addListener: (
    eventName: "click",
    handler: () => void,
  ) => GoogleMapsEventListener;
};
type GoogleAdvancedMarkerInstance = {
  map: GoogleMapInstance | null;
  position: LatLng;
  content?: HTMLElement;
  addEventListener?: (
    eventName: "gmp-click",
    handler: (event: unknown) => void,
  ) => void;
  removeEventListener?: (
    eventName: "gmp-click",
    handler: (event: unknown) => void,
  ) => void;
  addListener: (
    eventName: "click",
    handler: () => void,
  ) => GoogleMapsEventListener;
};
type GooglePinElementInstance = {
  element: HTMLElement;
};
type GoogleMapsMarkerNamespace = {
  AdvancedMarkerElement: new (options: {
    map?: GoogleMapInstance | null;
    position?: LatLng;
    title?: string;
    content?: HTMLElement;
    gmpClickable?: boolean;
  }) => GoogleAdvancedMarkerInstance;
  PinElement: new (options?: {
    background?: string;
    borderColor?: string;
    glyphColor?: string;
    glyph?: string;
    scale?: number;
  }) => GooglePinElementInstance;
};
type GoogleMapsNamespace = {
  Map: new (
    container: HTMLDivElement,
    options: Record<string, unknown>,
  ) => GoogleMapInstance;
  Marker: new (options: Record<string, unknown>) => GoogleMarkerInstance;
};

const defaultMapTarget = {
  lat: 30.3199786,
  lng: -86.1377563,
};

const SATELLITE_ZOOM_THRESHOLD = 16;
const CONTEXT_ZOOM = 13;
const ZOOM_STEP_DELAY_MS = 80;
const PAN_TO_NEW_PIN_DELAY_MS = 220;
let mapsLoaderConfigured = false;

function getMapTypeForZoom(zoom: number | undefined) {
  if (typeof zoom !== "number") {
    return "roadmap" as const;
  }
  return zoom >= SATELLITE_ZOOM_THRESHOLD ? "satellite" : "roadmap";
}

function getSecondaryMarkerPinOptions(zoom: number | undefined) {
  const highDetailZoom =
    typeof zoom === "number" && zoom >= SATELLITE_ZOOM_THRESHOLD;

  if (highDetailZoom) {
    return {
      background: "#a855f7",
      borderColor: "#ffffff",
      glyphColor: "#ffffff",
      glyph: "\u2302",
      scale: 1,
    };
  }

  return {
    background: "#a855f7",
    borderColor: "#ffffff",
    glyphColor: "#ffffff",
    scale: 0.85,
  };
}

function createSecondaryMarkerContent(
  markerLibrary: GoogleMapsMarkerNamespace,
  zoom: number | undefined,
) {
  const highDetailZoom =
    typeof zoom === "number" && zoom >= SATELLITE_ZOOM_THRESHOLD;

  if (highDetailZoom) {
    const pin = new markerLibrary.PinElement(
      getSecondaryMarkerPinOptions(zoom),
    );
    return pin.element;
  }

  const dot = document.createElement("div");
  dot.style.width = "12px";
  dot.style.height = "12px";
  dot.style.borderRadius = "999px";
  dot.style.background = "#a855f7";
  dot.style.border = "1.5px solid #ffffff";
  dot.style.boxShadow = "0 0 0 1px rgba(168,85,247,0.25)";
  return dot;
}

export function DiscoverMapPanel({
  mapTarget,
  listings,
  onClearPin,
  onSelectListing,
  isExpanded,
  onToggleExpanded,
}: {
  mapTarget: {
    id?: string;
    lat: number;
    lng: number;
    label: string;
    zoom?: number;
  };
  listings: ReadonlyArray<{
    id: string;
    name: string;
    lat: number;
    lng: number;
  }>;
  onClearPin: () => void;
  onSelectListing: (next: {
    id: string;
    lat: number;
    lng: number;
    label: string;
    zoom?: number;
  }) => void;
  isExpanded: boolean;
  onToggleExpanded: () => void;
}) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const googleMapRef = useRef<GoogleMapInstance | null>(null);
  const googleMapMarkerRef = useRef<GoogleAdvancedMarkerInstance | null>(null);
  const googleMapSecondaryMarkerRef = useRef<
    Map<string, GoogleAdvancedMarkerInstance>
  >(new Map());
  const markerListenerRef = useRef<Array<() => void>>([]);
  const googleMapsNamespaceRef = useRef<GoogleMapsNamespace | null>(null);
  const googleMapsMarkerNamespaceRef = useRef<GoogleMapsMarkerNamespace | null>(
    null,
  );
  const zoomAnimationIntervalRef = useRef<number | null>(null);
  const pendingPanTimeoutRef = useRef<number | null>(null);
  const previousPinnedListingIdRef = useRef<string | undefined>(undefined);
  const [mapReadyRevision, setMapReadyRevision] = useState(0);

  const mapEmbedSrc = `https://maps.google.com/maps?q=${encodeURIComponent(`${mapTarget.lat},${mapTarget.lng}`)}&t=&z=14&ie=UTF8&iwloc=&output=embed`;
  const openInMapsHref = `https://www.google.com/maps/search/?api=1&query=${mapTarget.lat}%2C${mapTarget.lng}`;

  const clearFocusAnimation = useCallback(() => {
    if (zoomAnimationIntervalRef.current !== null) {
      window.clearInterval(zoomAnimationIntervalRef.current);
      zoomAnimationIntervalRef.current = null;
    }
    if (pendingPanTimeoutRef.current !== null) {
      window.clearTimeout(pendingPanTimeoutRef.current);
      pendingPanTimeoutRef.current = null;
    }
  }, []);

  const clearSecondaryMarkers = () => {
    markerListenerRef.current.forEach((cleanup) => cleanup());
    markerListenerRef.current = [];

    for (const marker of googleMapSecondaryMarkerRef.current.values()) {
      marker.map = null;
    }
    googleMapSecondaryMarkerRef.current.clear();
  };

  const registerAdvancedMarkerClick = (
    marker: GoogleAdvancedMarkerInstance,
    onClick: () => void,
  ) => {
    if (marker.addEventListener && marker.removeEventListener) {
      const handler = () => {
        onClick();
      };
      marker.addEventListener("gmp-click", handler);
      return () => {
        marker.removeEventListener?.("gmp-click", handler);
      };
    }

    const listener = marker.addListener("click", onClick);
    return () => {
      listener.remove();
    };
  };

  const applySecondaryMarkerIcons = (zoom: number | undefined) => {
    const markerLibrary = googleMapsMarkerNamespaceRef.current;
    if (!markerLibrary) {
      return;
    }

    for (const marker of googleMapSecondaryMarkerRef.current.values()) {
      marker.content = createSecondaryMarkerContent(markerLibrary, zoom);
    }
  };

  const animateZoom = useCallback(
    (map: GoogleMapInstance, from: number, to: number, onDone?: () => void) => {
      if (from === to) {
        onDone?.();
        return;
      }

      const step = to > from ? 1 : -1;
      let current = from;

      clearFocusAnimation();
      zoomAnimationIntervalRef.current = window.setInterval(() => {
        current += step;
        map.setZoom(current);
        map.setMapTypeId(getMapTypeForZoom(current));

        if ((step > 0 && current >= to) || (step < 0 && current <= to)) {
          if (zoomAnimationIntervalRef.current !== null) {
            window.clearInterval(zoomAnimationIntervalRef.current);
            zoomAnimationIntervalRef.current = null;
          }
          onDone?.();
        }
      }, ZOOM_STEP_DELAY_MS);
    },
    [clearFocusAnimation],
  );

  useEffect(() => {
    if (!googleMapsApiKey || !mapContainerRef.current) {
      return;
    }

    let disposed = false;

    const initializeMap = async () => {
      if (!mapsLoaderConfigured) {
        setOptions({
          key: googleMapsApiKey,
          v: "weekly",
        });
        mapsLoaderConfigured = true;
      }
      await importLibrary("maps");
      await importLibrary("marker");

      const googleMaps = (
        window as Window & {
          google?: {
            maps?: GoogleMapsNamespace & {
              marker?: GoogleMapsMarkerNamespace;
            };
          };
        }
      ).google?.maps;
      const markerLibrary = googleMaps?.marker;

      if (
        disposed ||
        !mapContainerRef.current ||
        !googleMaps ||
        !markerLibrary
      ) {
        return;
      }

      const center = {
        lat: defaultMapTarget.lat,
        lng: defaultMapTarget.lng,
      };
      const map = new googleMaps.Map(mapContainerRef.current, {
        center,
        zoom: 13,
        mapTypeId: "roadmap",
        mapId: "DEMO_MAP_ID",
        disableDefaultUI: false,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false,
        gestureHandling: "greedy",
        scrollwheel: true,
      });

      const primaryPin = new markerLibrary.PinElement({
        background: "#ef4444",
        borderColor: "#ffffff",
        glyphColor: "#ffffff",
        scale: 1,
      });

      const marker = new markerLibrary.AdvancedMarkerElement({
        map: null,
        position: center,
        content: primaryPin.element,
        gmpClickable: false,
      });

      const zoomListener = map.addListener("zoom_changed", () => {
        const zoom = map.getZoom();
        map.setMapTypeId(getMapTypeForZoom(zoom));
        applySecondaryMarkerIcons(zoom);
      });

      googleMapRef.current = map;
      googleMapMarkerRef.current = marker;
      googleMapsNamespaceRef.current = googleMaps;
      googleMapsMarkerNamespaceRef.current = markerLibrary;
      setMapReadyRevision((current) => current + 1);

      if (disposed) {
        zoomListener.remove();
      }
    };

    void initializeMap();

    return () => {
      disposed = true;
      clearFocusAnimation();
      clearSecondaryMarkers();
    };
  }, [clearFocusAnimation]);

  useEffect(() => {
    const map = googleMapRef.current;
    const markerLibrary = googleMapsMarkerNamespaceRef.current;
    if (!map || !markerLibrary) {
      return;
    }

    clearSecondaryMarkers();

    for (const listing of listings) {
      if (mapTarget.id && listing.id === mapTarget.id) {
        continue;
      }

      const marker = new markerLibrary.AdvancedMarkerElement({
        map,
        position: { lat: listing.lat, lng: listing.lng },
        title: listing.name,
        content: createSecondaryMarkerContent(markerLibrary, map.getZoom()),
        gmpClickable: true,
      });

      const cleanup = registerAdvancedMarkerClick(marker, () => {
        onSelectListing({
          id: listing.id,
          lat: listing.lat,
          lng: listing.lng,
          label: listing.name,
          zoom: 19,
        });
      });

      markerListenerRef.current.push(cleanup);
      googleMapSecondaryMarkerRef.current.set(listing.id, marker);
    }

    applySecondaryMarkerIcons(map.getZoom());
  }, [listings, mapTarget.id, onSelectListing, mapReadyRevision]);

  useEffect(() => {
    const map = googleMapRef.current;
    const marker = googleMapMarkerRef.current;
    if (!map || !marker) {
      return;
    }

    if (!mapTarget.id) {
      previousPinnedListingIdRef.current = undefined;
      marker.map = null;
      clearFocusAnimation();
      map.panTo({ lat: mapTarget.lat, lng: mapTarget.lng });
      map.setZoom(mapTarget.zoom ?? CONTEXT_ZOOM);
      map.setMapTypeId("roadmap");
      return;
    }

    marker.map = map;

    const nextCenter = { lat: mapTarget.lat, lng: mapTarget.lng };
    marker.position = nextCenter;

    if (typeof mapTarget.zoom === "number") {
      const currentZoom = map.getZoom() ?? CONTEXT_ZOOM;
      const targetZoom = mapTarget.zoom;
      const hadPinnedListing = Boolean(previousPinnedListingIdRef.current);

      const panAndZoomInFromContext = () => {
        map.panTo(nextCenter);
        pendingPanTimeoutRef.current = window.setTimeout(() => {
          animateZoom(map, CONTEXT_ZOOM, targetZoom);
        }, PAN_TO_NEW_PIN_DELAY_MS);
      };

      const panAndAdjustZoom = () => {
        clearFocusAnimation();
        map.panTo(nextCenter);
        if (currentZoom !== targetZoom) {
          pendingPanTimeoutRef.current = window.setTimeout(
            () => {
              animateZoom(map, currentZoom, targetZoom);
            },
            Math.min(PAN_TO_NEW_PIN_DELAY_MS, 120),
          );
        }
      };

      if (hadPinnedListing) {
        panAndAdjustZoom();
      } else if (currentZoom > CONTEXT_ZOOM) {
        animateZoom(map, currentZoom, CONTEXT_ZOOM, panAndZoomInFromContext);
      } else {
        panAndZoomInFromContext();
      }

      previousPinnedListingIdRef.current = mapTarget.id;
    } else {
      clearFocusAnimation();
      map.panTo(nextCenter);
      previousPinnedListingIdRef.current = mapTarget.id;
    }
  }, [animateZoom, clearFocusAnimation, mapTarget, mapReadyRevision]);

  return (
    <aside className="flex flex-col self-start rounded-2xl border border-slate-200 bg-white/95 p-5 shadow-[0_14px_30px_-26px_rgba(15,23,42,0.75)] xl:sticky xl:top-28">
      <div className="flex items-center justify-between gap-2">
        <div className="inline-flex items-center gap-2">
          <button
            type="button"
            onClick={onToggleExpanded}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-cyan-200 bg-cyan-50 text-cyan-800 transition-colors hover:bg-cyan-100"
            aria-pressed={isExpanded}
            aria-label={isExpanded ? "Collapse map view" : "Expand map view"}
            title={isExpanded ? "Collapse map view" : "Expand map view"}
          >
            {isExpanded ? (
              <ChevronRight className="h-3.5 w-3.5" />
            ) : (
              <ChevronLeft className="h-3.5 w-3.5" />
            )}
          </button>
          <p className="text-[11px] font-bold tracking-[0.16em] text-slate-400 uppercase">
            Map View
          </p>
        </div>

        <div className="inline-flex items-center gap-1.5">
          <button
            type="button"
            onClick={onClearPin}
            disabled={!mapTarget.id}
            className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
              mapTarget.id
                ? "border-rose-200 bg-rose-50 text-rose-800 hover:bg-rose-100"
                : "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400"
            }`}
            aria-label="Clear selected map pin"
            title={mapTarget.id ? "Clear selected map pin" : "No pin selected"}
          >
            Clear Pin
          </button>
          <a
            href={openInMapsHref}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-md border border-cyan-200 bg-cyan-50 px-2.5 py-1 text-[11px] font-semibold text-cyan-800 transition-colors hover:bg-cyan-100"
          >
            Open in Maps
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </div>

      <div className="relative mt-3 h-88 overflow-hidden rounded-xl border border-slate-200 bg-slate-100 sm:h-104 xl:h-[calc(100dvh-8.5rem)] xl:max-h-232 xl:min-h-136">
        {googleMapsApiKey ? (
          <div
            ref={mapContainerRef}
            className="absolute inset-0 h-full w-full"
            aria-label="30A map"
          />
        ) : (
          <iframe
            title="30A map"
            src={mapEmbedSrc}
            className="absolute inset-0 h-full w-full"
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
          />
        )}
      </div>
    </aside>
  );
}
