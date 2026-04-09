import { importLibrary, setOptions } from "@googlemaps/js-api-loader";
import { ExternalLink } from "lucide-react";
import { useEffect, useRef } from "react";

import { googleMapsApiKey } from "@/components/discover/discover-data";

type LatLng = { lat: number; lng: number };
type GoogleMapInstance = { panTo: (center: LatLng) => void };
type GoogleMarkerInstance = { setPosition: (center: LatLng) => void };
type GoogleMapsNamespace = {
  Map: new (
    container: HTMLDivElement,
    options: Record<string, unknown>,
  ) => GoogleMapInstance;
  Marker: new (options: Record<string, unknown>) => GoogleMarkerInstance;
};

const defaultMapTarget = {
  lat: 30.3158,
  lng: -86.1186,
};

export function DiscoverMapPanel({
  mapTarget,
}: {
  mapTarget: { lat: number; lng: number; label: string };
}) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const googleMapRef = useRef<GoogleMapInstance | null>(null);
  const googleMapMarkerRef = useRef<GoogleMarkerInstance | null>(null);

  const mapEmbedSrc = `https://maps.google.com/maps?q=${encodeURIComponent(`${mapTarget.lat},${mapTarget.lng}`)}&t=&z=14&ie=UTF8&iwloc=&output=embed`;
  const openInMapsHref = `https://www.google.com/maps/search/?api=1&query=${mapTarget.lat}%2C${mapTarget.lng}`;

  useEffect(() => {
    if (!googleMapsApiKey || !mapContainerRef.current) {
      return;
    }

    let disposed = false;

    const initializeMap = async () => {
      setOptions({
        key: googleMapsApiKey,
        v: "weekly",
      });
      await importLibrary("maps");

      const googleMaps = (
        window as Window & {
          google?: {
            maps?: GoogleMapsNamespace;
          };
        }
      ).google?.maps;

      if (disposed || !mapContainerRef.current || !googleMaps) {
        return;
      }

      const center = {
        lat: defaultMapTarget.lat,
        lng: defaultMapTarget.lng,
      };
      const map = new googleMaps.Map(mapContainerRef.current, {
        center,
        zoom: 13,
        disableDefaultUI: false,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false,
        gestureHandling: "greedy",
        scrollwheel: true,
      });

      const marker = new googleMaps.Marker({
        map,
        position: center,
      });

      googleMapRef.current = map;
      googleMapMarkerRef.current = marker;
    };

    void initializeMap();

    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    const map = googleMapRef.current;
    const marker = googleMapMarkerRef.current;
    if (!map || !marker) {
      return;
    }

    const nextCenter = { lat: mapTarget.lat, lng: mapTarget.lng };
    map.panTo(nextCenter);
    marker.setPosition(nextCenter);
  }, [mapTarget]);

  return (
    <aside className="flex flex-col self-start rounded-2xl border border-slate-200 bg-white/95 p-5 shadow-[0_14px_30px_-26px_rgba(15,23,42,0.75)] xl:sticky xl:top-28">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-bold tracking-[0.16em] text-slate-400 uppercase">
          Map View
        </p>
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
