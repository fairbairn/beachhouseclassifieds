import { importLibrary, setOptions } from "@googlemaps/js-api-loader";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  RefreshCw,
  RotateCcw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { discoverCustomPois } from "@/components/discover/discover-custom-pois";
import { googleMapsApiKey } from "@/components/discover/discover-data";
import { getPlannedCommunityPolygonsByName } from "@/lib/discover/community-resolution";

type LatLng = { lat: number; lng: number };
type GoogleMapInstance = {
  panTo: (center: LatLng) => void;
  setZoom: (zoom: number) => void;
  fitBounds: (
    bounds: {
      extend: (point: LatLng) => void;
    },
    padding?: number,
  ) => void;
  getZoom: () => number | undefined;
  getCenter: () =>
    | { lat: () => number; lng: () => number }
    | { lat: number; lng: number }
    | null
    | undefined;
  setMapTypeId: (type: "roadmap" | "satellite") => void;
  addListener: (
    eventName: "zoom_changed" | "idle",
    handler: () => void,
  ) => { remove: () => void };
};
type GoogleMapsEventListener = { remove: () => void };
type GooglePolygonInstance = {
  setMap: (map: GoogleMapInstance | null) => void;
};
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
type GooglePinElementInstance = HTMLElement;
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
    scale?: number;
  }) => GooglePinElementInstance;
};
type GoogleMapsNamespace = {
  Map: new (
    container: HTMLDivElement,
    options: Record<string, unknown>,
  ) => GoogleMapInstance;
  Marker: new (options: Record<string, unknown>) => GoogleMarkerInstance;
  Polygon: new (options: {
    paths: LatLng[];
    strokeColor?: string;
    strokeOpacity?: number;
    strokeWeight?: number;
    fillColor?: string;
    fillOpacity?: number;
    clickable?: boolean;
    geodesic?: boolean;
    zIndex?: number;
  }) => GooglePolygonInstance;
  LatLngBounds?: new () => {
    extend: (point: LatLng) => void;
  };
};

const defaultMapTarget = {
  lat: 30.3199786,
  lng: -86.1377563,
};

const SATELLITE_ZOOM_THRESHOLD = 16;
const CONTEXT_ZOOM = 13;
const ZOOM_STEP_DELAY_MS = 80;
const PAN_TO_NEW_PIN_DELAY_MS = 220;
const RESET_CENTER_TOLERANCE = 0.0004;
const UNPINNED_FIT_PADDING_PX = 56;
const SINGLE_LISTING_UNPINNED_ZOOM = 15;
const DEBUG_WATERCOLOR_BOUNDARY_QUERY_KEY = "debugWatercolorBoundary";
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
  hoverPriceAmount?: string,
) {
  const highDetailZoom =
    typeof zoom === "number" && zoom >= SATELLITE_ZOOM_THRESHOLD;

  const createTooltipShell = (inner: HTMLElement) => {
    if (!hoverPriceAmount) {
      return inner;
    }

    const tooltip = document.createElement("div");
    tooltip.textContent = hoverPriceAmount;
    tooltip.style.position = "absolute";
    tooltip.style.left = "50%";
    tooltip.style.bottom = "calc(100% + 8px)";
    tooltip.style.transform = "translateX(-50%) translateY(4px)";
    tooltip.style.background = "rgba(255,255,255,0.88)";
    tooltip.style.border = "1px solid rgba(148,163,184,0.35)";
    tooltip.style.borderRadius = "999px";
    tooltip.style.padding = "4px 10px";
    tooltip.style.fontSize = "12px";
    tooltip.style.fontWeight = "700";
    tooltip.style.lineHeight = "1";
    tooltip.style.color = "#0f172a";
    tooltip.style.whiteSpace = "nowrap";
    tooltip.style.boxShadow = "0 10px 20px -14px rgba(15,23,42,0.75)";
    tooltip.style.opacity = "0";
    tooltip.style.pointerEvents = "none";
    tooltip.style.transition = "opacity 140ms ease, transform 140ms ease";
    tooltip.style.zIndex = "2";

    const shell = document.createElement("div");
    shell.style.position = "relative";
    shell.style.display = "inline-flex";
    shell.style.alignItems = "center";
    shell.style.justifyContent = "center";

    shell.addEventListener("mouseenter", () => {
      tooltip.style.opacity = "1";
      tooltip.style.transform = "translateX(-50%) translateY(0)";
    });

    shell.addEventListener("mouseleave", () => {
      tooltip.style.opacity = "0";
      tooltip.style.transform = "translateX(-50%) translateY(4px)";
    });

    shell.appendChild(tooltip);
    shell.appendChild(inner);
    return shell;
  };

  if (highDetailZoom) {
    const pin = new markerLibrary.PinElement(
      getSecondaryMarkerPinOptions(zoom),
    );
    return createTooltipShell(pin);
  }

  const dot = document.createElement("div");
  dot.style.width = "12px";
  dot.style.height = "12px";
  dot.style.borderRadius = "999px";
  dot.style.background = "#a855f7";
  dot.style.border = "1.5px solid #ffffff";
  dot.style.boxShadow = "0 0 0 1px rgba(168,85,247,0.25)";
  return createTooltipShell(dot);
}

function createPrimaryMarkerContent(
  markerLibrary: GoogleMapsMarkerNamespace,
  hoverPriceAmount?: string,
) {
  const pin = new markerLibrary.PinElement({
    background: "#ef4444",
    borderColor: "#ffffff",
    glyphColor: "#ffffff",
    scale: 1,
  });

  if (!hoverPriceAmount) {
    return pin;
  }

  const tooltip = document.createElement("div");
  tooltip.textContent = hoverPriceAmount;
  tooltip.style.position = "absolute";
  tooltip.style.left = "50%";
  tooltip.style.bottom = "calc(100% + 8px)";
  tooltip.style.transform = "translateX(-50%) translateY(4px)";
  tooltip.style.background = "rgba(255,255,255,0.88)";
  tooltip.style.border = "1px solid rgba(148,163,184,0.35)";
  tooltip.style.borderRadius = "999px";
  tooltip.style.padding = "4px 10px";
  tooltip.style.fontSize = "12px";
  tooltip.style.fontWeight = "700";
  tooltip.style.lineHeight = "1";
  tooltip.style.color = "#0f172a";
  tooltip.style.whiteSpace = "nowrap";
  tooltip.style.boxShadow = "0 10px 20px -14px rgba(15,23,42,0.75)";
  tooltip.style.opacity = "0";
  tooltip.style.pointerEvents = "none";
  tooltip.style.transition = "opacity 140ms ease, transform 140ms ease";
  tooltip.style.zIndex = "2";

  const shell = document.createElement("div");
  shell.style.position = "relative";
  shell.style.display = "inline-flex";
  shell.style.alignItems = "center";
  shell.style.justifyContent = "center";

  shell.addEventListener("mouseenter", () => {
    tooltip.style.opacity = "1";
    tooltip.style.transform = "translateX(-50%) translateY(0)";
  });

  shell.addEventListener("mouseleave", () => {
    tooltip.style.opacity = "0";
    tooltip.style.transform = "translateX(-50%) translateY(4px)";
  });

  shell.appendChild(tooltip);
  shell.appendChild(pin);
  return shell;
}

export function DiscoverMapPanel({
  mapTarget,
  listings,
  onClearPin,
  onResetMapView,
  onSelectListing,
  onSyncSelectedListingCard,
  isSyncSelectedListingCardAvailable,
  isExpanded,
  onToggleExpanded,
  showExpandControl = true,
  showSyncControl = true,
  showClearPinControl = true,
  resetToInitialTargetView = false,
  stickyOnDesktop = true,
  panelClassName,
  mapViewportClassName,
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
    hoverPriceAmount: string;
  }>;
  onClearPin: () => void;
  onResetMapView: () => void;
  onSelectListing: (next: {
    id: string;
    lat: number;
    lng: number;
    label: string;
    zoom?: number;
  }) => void;
  onSyncSelectedListingCard: () => void;
  isSyncSelectedListingCardAvailable: boolean;
  isExpanded: boolean;
  onToggleExpanded: () => void;
  showExpandControl?: boolean;
  showSyncControl?: boolean;
  showClearPinControl?: boolean;
  resetToInitialTargetView?: boolean;
  stickyOnDesktop?: boolean;
  panelClassName?: string;
  mapViewportClassName?: string;
}) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const googleMapRef = useRef<GoogleMapInstance | null>(null);
  const googleMapMarkerRef = useRef<GoogleAdvancedMarkerInstance | null>(null);
  const listingHoverPriceMapRef = useRef<Map<string, string>>(new Map());
  const googleMapSecondaryMarkerRef = useRef<
    Map<string, GoogleAdvancedMarkerInstance>
  >(new Map());
  const customPoiMarkerRef = useRef<Map<string, GoogleAdvancedMarkerInstance>>(
    new Map(),
  );
  const watercolorBoundaryPolygonRef = useRef<GooglePolygonInstance | null>(
    null,
  );
  const markerListenerRef = useRef<Array<() => void>>([]);
  const googleMapsNamespaceRef = useRef<GoogleMapsNamespace | null>(null);
  const googleMapsMarkerNamespaceRef = useRef<GoogleMapsMarkerNamespace | null>(
    null,
  );
  const zoomAnimationIntervalRef = useRef<number | null>(null);
  const pendingPanTimeoutRef = useRef<number | null>(null);
  const mapEventCleanupRef = useRef<Array<() => void>>([]);
  const previousPinnedListingIdRef = useRef<string | undefined>(undefined);
  const initialMapTargetRef = useRef(mapTarget);
  const activeMapTargetIdRef = useRef<string | undefined>(mapTarget.id);
  const syncSelectedListingCardRef = useRef(onSyncSelectedListingCard);
  const [isMapInResetState, setIsMapInResetState] = useState(true);
  const [mapReadyRevision, setMapReadyRevision] = useState(0);
  const listingsGeometry = useMemo(
    () =>
      listings.map((listing) => ({
        id: listing.id,
        name: listing.name,
        lat: listing.lat,
        lng: listing.lng,
      })),
    [listings],
  );

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

  const clearCustomPoiMarkers = () => {
    for (const marker of customPoiMarkerRef.current.values()) {
      marker.map = null;
    }
    customPoiMarkerRef.current.clear();
  };

  const clearWatercolorBoundaryPolygon = () => {
    if (!watercolorBoundaryPolygonRef.current) {
      return;
    }
    watercolorBoundaryPolygonRef.current.setMap(null);
    watercolorBoundaryPolygonRef.current = null;
  };

  const createCustomPoiContent = (poi: (typeof discoverCustomPois)[number]) => {
    const isBeachAccessPoi = /(?:beach access|access)$/i.test(poi.name.trim());
    const markerColor = isBeachAccessPoi
      ? "#facc15"
      : poi.kind === "sports-field" || poi.kind === "park"
        ? "#22c55e"
        : "#0284c7";
    const labelColor = isBeachAccessPoi
      ? "#fde047"
      : poi.kind === "sports-field" || poi.kind === "park"
        ? "#4ade80"
        : "#38bdf8";

    const container = document.createElement("div");
    container.style.position = "relative";
    container.style.display = "inline-flex";
    container.style.alignItems = "center";
    container.style.justifyContent = "center";

    const dot = document.createElement("div");
    dot.style.width = poi.kind === "sports-field" ? "10px" : "11px";
    dot.style.height = poi.kind === "sports-field" ? "10px" : "11px";
    dot.style.borderRadius = "999px";
    dot.style.background = markerColor;
    dot.style.border = "1.5px solid #ffffff";
    dot.style.boxShadow = "0 0 0 1px rgba(15,23,42,0.18)";

    const label = document.createElement("div");
    label.textContent = poi.name;
    label.style.position = "absolute";
    label.style.left = "50%";
    label.style.bottom = "calc(100% + 8px)";
    label.style.transform = "translateX(-50%)";
    label.style.transition =
      "background-color 140ms ease, border-color 140ms ease, color 140ms ease, box-shadow 140ms ease, text-shadow 140ms ease, padding 140ms ease, border-radius 140ms ease";
    label.style.fontSize = "12px";
    label.style.fontWeight = "700";
    label.style.lineHeight = "1";
    label.style.whiteSpace = "nowrap";
    label.style.pointerEvents = "none";

    const applyDefaultLabelStyle = () => {
      label.style.background = "transparent";
      label.style.border = "1px solid transparent";
      label.style.borderRadius = "999px";
      label.style.padding = "4px 10px";
      label.style.color = labelColor;
      label.style.boxShadow = "none";
      label.style.textShadow = "0 1px 3px rgba(15,23,42,0.72)";
    };

    const applyHoverLabelStyle = () => {
      label.style.background = markerColor;
      label.style.border = "1px solid rgba(255,255,255,0.78)";
      label.style.borderRadius = "999px";
      label.style.padding = "4px 10px";
      label.style.color = isBeachAccessPoi ? "#1f2937" : "#ffffff";
      label.style.boxShadow = "0 10px 20px -14px rgba(15,23,42,0.75)";
      label.style.textShadow = "none";
    };

    applyDefaultLabelStyle();
    container.addEventListener("mouseenter", applyHoverLabelStyle);
    container.addEventListener("mouseleave", applyDefaultLabelStyle);
    label.style.pointerEvents = "auto";

    container.appendChild(label);
    container.appendChild(dot);
    return container;
  };

  const updateCustomPoiMarkerVisibility = (zoom: number | undefined) => {
    const map = googleMapRef.current;
    if (!map) {
      return;
    }

    const shouldShow =
      typeof zoom === "number" && zoom >= SATELLITE_ZOOM_THRESHOLD;

    for (const marker of customPoiMarkerRef.current.values()) {
      marker.map = shouldShow ? map : null;
    }
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

  const updateResetState = useCallback(
    (map: GoogleMapInstance | null) => {
      if (!map) {
        setIsMapInResetState(true);
        return;
      }

      if (activeMapTargetIdRef.current) {
        if (resetToInitialTargetView) {
          const zoom = map.getZoom() ?? 19;
          const center = map.getCenter();
          const lat =
            center && typeof center.lat === "function"
              ? center.lat()
              : center?.lat;
          const lng =
            center && typeof center.lng === "function"
              ? center.lng()
              : center?.lng;

          if (typeof lat !== "number" || typeof lng !== "number") {
            setIsMapInResetState(false);
            return;
          }

          const targetZoom =
            typeof mapTarget.zoom === "number" ? mapTarget.zoom : 19;
          const isAtTargetCenter =
            Math.abs(lat - mapTarget.lat) <= RESET_CENTER_TOLERANCE &&
            Math.abs(lng - mapTarget.lng) <= RESET_CENTER_TOLERANCE;
          const isAtTargetZoom = Math.abs(zoom - targetZoom) < 0.01;

          setIsMapInResetState(isAtTargetCenter && isAtTargetZoom);
          return;
        }

        setIsMapInResetState(false);
        return;
      }

      const zoom = map.getZoom() ?? CONTEXT_ZOOM;
      const center = map.getCenter();
      const lat =
        center && typeof center.lat === "function" ? center.lat() : center?.lat;
      const lng =
        center && typeof center.lng === "function" ? center.lng() : center?.lng;

      if (typeof lat !== "number" || typeof lng !== "number") {
        setIsMapInResetState(false);
        return;
      }

      const isAtDefaultCenter =
        Math.abs(lat - defaultMapTarget.lat) <= RESET_CENTER_TOLERANCE &&
        Math.abs(lng - defaultMapTarget.lng) <= RESET_CENTER_TOLERANCE;
      const isAtDefaultZoom = Math.abs(zoom - CONTEXT_ZOOM) < 0.01;

      setIsMapInResetState(isAtDefaultCenter && isAtDefaultZoom);
    },
    [mapTarget.lat, mapTarget.lng, mapTarget.zoom, resetToInitialTargetView],
  );

  useEffect(() => {
    activeMapTargetIdRef.current = mapTarget.id;
    updateResetState(googleMapRef.current);
  }, [mapTarget.id, updateResetState]);

  useEffect(() => {
    syncSelectedListingCardRef.current = onSyncSelectedListingCard;
  }, [onSyncSelectedListingCard]);

  const handleResetMapView = useCallback(() => {
    const map = googleMapRef.current;
    const googleMaps = googleMapsNamespaceRef.current;
    if (!map) {
      return;
    }

    clearFocusAnimation();

    if (mapTarget.id) {
      onClearPin();
    }

    if (listingsGeometry.length === 0) {
      updateResetState(map);
      return;
    }

    if (listingsGeometry.length === 1) {
      const onlyListing = listingsGeometry[0];
      map.panTo({ lat: onlyListing.lat, lng: onlyListing.lng });
      map.setZoom(SINGLE_LISTING_UNPINNED_ZOOM);
      map.setMapTypeId(getMapTypeForZoom(SINGLE_LISTING_UNPINNED_ZOOM));
      updateResetState(map);
      return;
    }

    const BoundsCtor = googleMaps?.LatLngBounds;
    if (!BoundsCtor) {
      updateResetState(map);
      return;
    }

    const bounds = new BoundsCtor();
    for (const listing of listingsGeometry) {
      bounds.extend({ lat: listing.lat, lng: listing.lng });
    }

    map.fitBounds(bounds, UNPINNED_FIT_PADDING_PX);
    updateResetState(map);
  }, [
    clearFocusAnimation,
    listingsGeometry,
    mapTarget.id,
    onClearPin,
    onResetMapView,
    resetToInitialTargetView,
    updateResetState,
  ]);

  const applySecondaryMarkerIcons = (zoom: number | undefined) => {
    const markerLibrary = googleMapsMarkerNamespaceRef.current;
    if (!markerLibrary) {
      return;
    }

    for (const [listingId, marker] of googleMapSecondaryMarkerRef.current) {
      marker.content = createSecondaryMarkerContent(
        markerLibrary,
        zoom,
        listingHoverPriceMapRef.current.get(listingId),
      );
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

      const initialTarget = initialMapTargetRef.current;
      const center = initialTarget.id
        ? {
            lat: initialTarget.lat,
            lng: initialTarget.lng,
          }
        : {
            lat: defaultMapTarget.lat,
            lng: defaultMapTarget.lng,
          };
      const initialZoom =
        initialTarget.id && typeof initialTarget.zoom === "number"
          ? initialTarget.zoom
          : initialTarget.id
            ? 19
            : CONTEXT_ZOOM;
      const map = new googleMaps.Map(mapContainerRef.current, {
        center,
        zoom: initialZoom,
        mapTypeId: getMapTypeForZoom(initialZoom),
        mapId: "DEMO_MAP_ID",
        disableDefaultUI: false,
        cameraControl: false,
        rotateControl: false,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false,
        gestureHandling: "greedy",
        scrollwheel: true,
      });

      const marker = new markerLibrary.AdvancedMarkerElement({
        map: null,
        position: center,
        content: createPrimaryMarkerContent(markerLibrary, undefined),
        gmpClickable: true,
      });

      const primaryMarkerClickCleanup = registerAdvancedMarkerClick(
        marker,
        () => {
          if (!activeMapTargetIdRef.current) {
            return;
          }

          syncSelectedListingCardRef.current();
        },
      );

      const zoomListener = map.addListener("zoom_changed", () => {
        const zoom = map.getZoom();
        map.setMapTypeId(getMapTypeForZoom(zoom));
        applySecondaryMarkerIcons(zoom);
        updateCustomPoiMarkerVisibility(zoom);
        updateResetState(map);
      });
      const idleListener = map.addListener("idle", () => {
        updateResetState(map);
      });

      mapEventCleanupRef.current.push(() => {
        zoomListener.remove();
        idleListener.remove();
      });

      googleMapRef.current = map;
      googleMapMarkerRef.current = marker;
      googleMapsNamespaceRef.current = googleMaps;
      googleMapsMarkerNamespaceRef.current = markerLibrary;
      setMapReadyRevision((current) => current + 1);

      if (disposed) {
        primaryMarkerClickCleanup();
        zoomListener.remove();
        idleListener.remove();
      }

      return () => {
        primaryMarkerClickCleanup();
        zoomListener.remove();
      };
    };

    void initializeMap();

    return () => {
      disposed = true;
      clearFocusAnimation();
      clearSecondaryMarkers();
      clearCustomPoiMarkers();
      clearWatercolorBoundaryPolygon();
      mapEventCleanupRef.current.forEach((cleanup) => cleanup());
      mapEventCleanupRef.current = [];
    };
  }, [clearFocusAnimation, updateResetState]);

  useEffect(() => {
    const map = googleMapRef.current;
    const googleMaps = googleMapsNamespaceRef.current;
    if (!map || !googleMaps) {
      return;
    }

    clearWatercolorBoundaryPolygon();

    if (!import.meta.env.DEV) {
      return;
    }

    const searchParams = new URLSearchParams(window.location.search);
    const isEnabled =
      searchParams.get(DEBUG_WATERCOLOR_BOUNDARY_QUERY_KEY) === "1";
    if (!isEnabled) {
      return;
    }

    const watercolorPolygons = getPlannedCommunityPolygonsByName("WaterColor");
    const watercolorBoundary = watercolorPolygons[0];
    if (!watercolorBoundary || watercolorBoundary.length < 3) {
      return;
    }

    const overlay = new googleMaps.Polygon({
      paths: watercolorBoundary,
      strokeColor: "#0ea5a4",
      strokeOpacity: 0.95,
      strokeWeight: 2,
      fillColor: "#14b8a6",
      fillOpacity: 0.2,
      clickable: false,
      geodesic: true,
      zIndex: 10,
    });

    overlay.setMap(map);
    watercolorBoundaryPolygonRef.current = overlay;

    return () => {
      clearWatercolorBoundaryPolygon();
    };
  }, [mapReadyRevision]);

  useEffect(() => {
    const map = googleMapRef.current;
    const markerLibrary = googleMapsMarkerNamespaceRef.current;
    const googleMaps = googleMapsNamespaceRef.current;
    if (!map || !markerLibrary) {
      return;
    }

    clearCustomPoiMarkers();

    for (const poi of discoverCustomPois) {
      const marker = new markerLibrary.AdvancedMarkerElement({
        map: null,
        position: { lat: poi.lat, lng: poi.lng },
        content: createCustomPoiContent(poi),
        gmpClickable: false,
      });

      customPoiMarkerRef.current.set(poi.id, marker);
    }

    updateCustomPoiMarkerVisibility(map.getZoom());

    return () => {
      clearCustomPoiMarkers();
    };
  }, [mapReadyRevision]);

  useEffect(() => {
    const map = googleMapRef.current;
    const markerLibrary = googleMapsMarkerNamespaceRef.current;
    const googleMaps = googleMapsNamespaceRef.current;
    if (!map || !markerLibrary) {
      return;
    }

    listingHoverPriceMapRef.current = new Map(
      listings.map((listing) => [listing.id, listing.hoverPriceAmount]),
    );

    clearSecondaryMarkers();

    for (const listing of listingsGeometry) {
      if (mapTarget.id && listing.id === mapTarget.id) {
        continue;
      }

      const marker = new markerLibrary.AdvancedMarkerElement({
        map,
        position: { lat: listing.lat, lng: listing.lng },
        content: createSecondaryMarkerContent(
          markerLibrary,
          map.getZoom(),
          listingHoverPriceMapRef.current.get(listing.id),
        ),
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

    if (mapTarget.id) {
      return;
    }

    if (listingsGeometry.length === 0) {
      return;
    }

    if (listingsGeometry.length === 1) {
      const onlyListing = listingsGeometry[0];
      map.panTo({ lat: onlyListing.lat, lng: onlyListing.lng });
      map.setZoom(SINGLE_LISTING_UNPINNED_ZOOM);
      return;
    }

    const BoundsCtor = googleMaps?.LatLngBounds;
    if (!BoundsCtor) {
      return;
    }

    const bounds = new BoundsCtor();
    for (const listing of listingsGeometry) {
      bounds.extend({ lat: listing.lat, lng: listing.lng });
    }

    map.fitBounds(bounds, UNPINNED_FIT_PADDING_PX);
  }, [
    listings,
    listingsGeometry,
    mapTarget.id,
    onSelectListing,
    mapReadyRevision,
  ]);

  useEffect(() => {
    const map = googleMapRef.current;
    const markerLibrary = googleMapsMarkerNamespaceRef.current;
    if (!map || !markerLibrary) {
      return;
    }

    listingHoverPriceMapRef.current = new Map(
      listings.map((listing) => [listing.id, listing.hoverPriceAmount]),
    );

    applySecondaryMarkerIcons(map.getZoom());

    if (mapTarget.id && googleMapMarkerRef.current) {
      googleMapMarkerRef.current.content = createPrimaryMarkerContent(
        markerLibrary,
        listingHoverPriceMapRef.current.get(mapTarget.id),
      );
    }
  }, [listings, mapTarget.id]);

  useEffect(() => {
    const map = googleMapRef.current;
    const marker = googleMapMarkerRef.current;
    if (!map || !marker) {
      return;
    }

    if (!mapTarget.id) {
      marker.map = null;
      clearFocusAnimation();
      return;
    }

    marker.map = map;

    const markerLibrary = googleMapsMarkerNamespaceRef.current;
    const activeHoverPrice = listingHoverPriceMapRef.current.get(mapTarget.id);
    if (markerLibrary) {
      marker.content = createPrimaryMarkerContent(
        markerLibrary,
        activeHoverPrice,
      );
    }

    const nextCenter = { lat: mapTarget.lat, lng: mapTarget.lng };
    marker.position = nextCenter;

    if (typeof mapTarget.zoom === "number") {
      const currentZoom = map.getZoom() ?? CONTEXT_ZOOM;
      const targetZoom = mapTarget.zoom;

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

      panAndAdjustZoom();

      previousPinnedListingIdRef.current = mapTarget.id;
    } else {
      clearFocusAnimation();
      map.panTo(nextCenter);
      previousPinnedListingIdRef.current = mapTarget.id;
    }
  }, [animateZoom, clearFocusAnimation, mapTarget, mapReadyRevision]);

  const basePanelClassName =
    "flex flex-col self-start rounded-2xl border border-slate-200 bg-white/95 p-5 shadow-[0_14px_30px_-26px_rgba(15,23,42,0.75)]";
  const stickyClassName = stickyOnDesktop ? " xl:sticky xl:top-28" : "";
  const resolvedPanelClassName = panelClassName
    ? `${basePanelClassName}${stickyClassName} ${panelClassName}`
    : `${basePanelClassName}${stickyClassName}`;
  const resolvedMapViewportClassName =
    mapViewportClassName ??
    "relative mt-3 h-88 overflow-hidden rounded-xl border border-slate-200 bg-slate-100 sm:h-104 xl:h-[calc(100dvh-8.5rem)] xl:max-h-232 xl:min-h-136";

  return (
    <aside className={resolvedPanelClassName}>
      <div className="flex items-center justify-between gap-2">
        <div className="inline-flex items-center gap-2">
          {showExpandControl ? (
            <>
              <button
                type="button"
                onClick={onToggleExpanded}
                className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-cyan-200 bg-cyan-50 text-cyan-800 transition-colors hover:bg-cyan-100"
                aria-pressed={isExpanded}
                aria-label={
                  isExpanded ? "Collapse map view" : "Expand map view"
                }
                title={isExpanded ? "Collapse map view" : "Expand map view"}
              >
                {isExpanded ? (
                  <ChevronRight className="h-3.5 w-3.5" />
                ) : (
                  <ChevronLeft className="h-3.5 w-3.5" />
                )}
              </button>
              {isExpanded ? (
                <p className="text-[11px] font-bold tracking-[0.16em] text-slate-400 uppercase">
                  Map Expanded
                </p>
              ) : null}
            </>
          ) : null}
        </div>

        <div className="inline-flex items-center gap-1.5">
          {showSyncControl ? (
            <button
              type="button"
              onClick={onSyncSelectedListingCard}
              disabled={!isSyncSelectedListingCardAvailable}
              className={`relative inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11px] font-semibold whitespace-nowrap transition-colors ${
                isSyncSelectedListingCardAvailable
                  ? "border-cyan-200 bg-cyan-50 text-cyan-800 hover:bg-cyan-100"
                  : "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400"
              }`}
              aria-label="Scroll selected listing card into view"
              title={
                isSyncSelectedListingCardAvailable
                  ? "Scroll selected listing card into view"
                  : "Pinned card already visible or no pin selected"
              }
            >
              {isSyncSelectedListingCardAvailable ? (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute -inset-0.5 animate-ping rounded-md border border-cyan-300/80"
                />
              ) : null}
              <RefreshCw className="h-3 w-3" />
              Sync
            </button>
          ) : null}
          {showClearPinControl ? (
            <button
              type="button"
              onClick={onClearPin}
              disabled={!mapTarget.id}
              className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11px] font-semibold whitespace-nowrap transition-colors ${
                mapTarget.id
                  ? "border-rose-200 bg-rose-50 text-rose-800 hover:bg-rose-100"
                  : "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400"
              }`}
              aria-label="Clear selected map pin"
              title={
                mapTarget.id ? "Clear selected map pin" : "No pin selected"
              }
            >
              <X className="h-3 w-3" />
              Clear Pin
            </button>
          ) : null}
          <button
            type="button"
            onClick={handleResetMapView}
            disabled={isMapInResetState}
            className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11px] font-semibold whitespace-nowrap transition-colors ${
              isMapInResetState
                ? "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400"
                : "border-cyan-200 bg-cyan-50 text-cyan-800 hover:bg-cyan-100"
            }`}
            aria-label="Reset map view"
            title={isMapInResetState ? "Map already reset" : "Reset map view"}
          >
            <RotateCcw className="h-3 w-3" />
            Reset
          </button>
          <a
            href={openInMapsHref}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-cyan-200 bg-cyan-50 text-cyan-800 transition-colors hover:bg-cyan-100"
            aria-label="Open in Google Maps"
            title="Open in Google Maps"
          >
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </div>

      <div className={resolvedMapViewportClassName}>
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
