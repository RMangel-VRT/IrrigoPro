import { useEffect, useRef, useState, useCallback, type ReactNode } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MapPin, RotateCcw, Navigation, Loader2 } from "lucide-react";
import { addSatelliteHybrid } from "@/lib/leaflet-base-layers";
import { drawPropertyBoundary, geoJsonBounds } from "@/lib/boundary-style";
import type { PropertyBoundary } from "@/lib/property-boundary";

delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png",
  iconUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png",
  shadowUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png",
});

export interface LocationPickerProps {
  /** Kept for API compat — used only for reverse-geocode display after a pin
   *  drop. Not used for map centering (centering uses pin → boundary → company
   *  fallback → regional fallback). */
  defaultAddress?: string;
  onLocationSelect: (location: {
    lat: number;
    lng: number;
    address?: string;
    source?: "gps" | "manual";
    accuracyM?: number | null;
    gpsError?: string | null;
  }) => void;
  selectedLocation?: { lat: number; lng: number; address?: string } | null;
  customerBoundary?: PropertyBoundary | null;
  /**
   * When the customer has no pin and no property boundary, the map falls back
   * to centering on this address string (typically the company address).
   * A soft yellow inline notice is shown when this fallback is used and no
   * pin has been dropped yet.
   *
   * May arrive after the first render (e.g. on a React Query cache miss) — the
   * component handles this with a reactive re-center effect so the map will
   * pan to the company address as soon as the value resolves.
   */
  companyFallbackAddress?: string | null;
  /**
   * Signal from the caller that the boundary lookup has definitively settled
   * (whether or not a boundary was found). Defaults to `true` — callers that
   * don't use boundary lookup should leave this unset.
   *
   * When `false` (boundary query still in-flight), the reactive company-fallback
   * re-center is suppressed so the company address is never applied in place of
   * a boundary that hasn't arrived yet.
   */
  boundaryResolved?: boolean;
  /**
   * True when the customer record has a non-empty address string. When true,
   * the company fallback centering is suppressed — company address is only used
   * when the customer has NO address AND NO boundary. Defaults to `false`.
   */
  hasCustomerAddress?: boolean;
  className?: string;
  /** Optional controls rendered inside the same location card, below the map. */
  children?: ReactNode;
}

const PULSING_DOT_CSS = `
.leaflet-pulsing-dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #1E5A99;
  border: 3px solid white;
  box-shadow: 0 0 0 rgba(59,130,246,0.4);
  animation: pulse-ring 2s ease-out infinite;
  position: relative;
}
@keyframes pulse-ring {
  0% { box-shadow: 0 0 0 0 rgba(59,130,246,0.5); }
  70% { box-shadow: 0 0 0 16px rgba(59,130,246,0); }
  100% { box-shadow: 0 0 0 0 rgba(59,130,246,0); }
}
`;

const FALLBACK_CENTER: [number, number] = [39.8283, -98.5795];
const FALLBACK_ZOOM = 12;

// What was used to center the map on first mount. Used to gate the reactive
// re-center effect that handles late-arriving companyFallbackAddress.
type CenteredBy = "pin" | "boundary" | "company" | "regional";

async function reverseGeocode(lat: number, lng: number): Promise<string> {
  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`
    );
    const data = await response.json();
    if (data && data.display_name) {
      return data.display_name;
    }
  } catch {
  }
  return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}

function canUseNetwork(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

async function forwardGeocode(address: string): Promise<[number, number] | null> {
  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}&limit=1`
    );
    const data = await response.json();
    if (Array.isArray(data) && data.length > 0) {
      const { lat, lon } = data[0];
      return [parseFloat(lat), parseFloat(lon)];
    }
  } catch {
  }
  return null;
}

export function LocationPicker({
  onLocationSelect,
  selectedLocation,
  customerBoundary,
  companyFallbackAddress,
  boundaryResolved = true,
  hasCustomerAddress = false,
  className = "",
  children,
}: LocationPickerProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const boundaryLayerRef = useRef<L.LayerGroup | null>(null);
  const liveLocationMarkerRef = useRef<L.Marker | null>(null);
  const watchIdRef = useRef<number | null>(null);
  const liveLocationRef = useRef<{ lat: number; lng: number } | null>(null);
  const selectionRevisionRef = useRef(0);

  // Tracks what was used for the initial map centering so the reactive
  // company-fallback effect knows whether it should re-center.
  const centeredByRef = useRef<CenteredBy | null>(null);

  const [isLoading, setIsLoading] = useState(false);
  const [isLocating, setIsLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [usedCompanyFallback, setUsedCompanyFallback] = useState(false);
  // Tracks whether a pin is currently placed — set immediately on click (before
  // the async reverse-geocode resolves) so the yellow notice disappears the
  // moment the tech drops a pin, not after parent state propagates.
  const [hasPinDropped, setHasPinDropped] = useState(!!selectedLocation);
  const gpsFailureRef = useRef<string | null>(null);

  const hasBoundary = !!customerBoundary;

  const updateLiveLocationMarker = useCallback((lat: number, lng: number) => {
    const map = mapInstanceRef.current;
    if (!map) return;

    liveLocationRef.current = { lat, lng };

    if (liveLocationMarkerRef.current) {
      liveLocationMarkerRef.current.setLatLng([lat, lng]);
    } else {
      const icon = L.divIcon({
        className: 'leaflet-pulsing-dot-container',
        html: '<div class="leaflet-pulsing-dot"></div>',
        iconSize: [20, 20],
        iconAnchor: [10, 10],
      });
      const marker = L.marker([lat, lng], { icon, interactive: false, zIndexOffset: -1000 }).addTo(map);
      liveLocationMarkerRef.current = marker;
    }
  }, []);

  // Initialize the map once on mount. Centering priority:
  // 1. existing pin  → center + zoom 20
  // 2. customer boundary → fitBounds
  // 3. company address fallback (if available at mount time) → geocode + zoom 12
  // 4. regional fallback → FALLBACK_CENTER zoom 12
  //
  // centeredByRef records which branch was taken. When companyFallbackAddress
  // arrives AFTER the map has mounted (React Query cache miss), the reactive
  // effect below handles re-centering — the init effect only handles the case
  // where the prop was already available.
  //
  // The map ALWAYS mounts — no dead-end mapless state.
  useEffect(() => {
    if (!mapRef.current || mapInstanceRef.current) return;

    if (!document.getElementById('pulsing-dot-styles')) {
      const style = document.createElement('style');
      style.id = 'pulsing-dot-styles';
      style.textContent = PULSING_DOT_CSS;
      document.head.appendChild(style);
    }

    const initializeMap = async () => {
      setIsLoading(true);

      let initialCenter: [number, number] = FALLBACK_CENTER;
      let initialZoom = FALLBACK_ZOOM;
      let fitToBoundary = false;
      let centeredBy: CenteredBy = "regional";

      if (selectedLocation) {
        initialCenter = [selectedLocation.lat, selectedLocation.lng];
        initialZoom = 20;
        centeredBy = "pin";
      } else if (customerBoundary) {
        initialCenter = [customerBoundary.centerLat, customerBoundary.centerLng];
        initialZoom = customerBoundary.zoom;
        fitToBoundary = true;
        centeredBy = "boundary";
      } else if (!hasCustomerAddress && companyFallbackAddress) {
        // Only consult company address when the customer has NO address and NO boundary.
        const coords = canUseNetwork()
          ? await forwardGeocode(companyFallbackAddress)
          : null;
        if (coords) {
          initialCenter = coords;
          initialZoom = 12;
          centeredBy = "company";
        }
        // else: remain "regional" / FALLBACK_CENTER
      }

      const map = L.map(mapRef.current!, {
        center: initialCenter,
        zoom: initialZoom,
        zoomControl: true,
        maxZoom: 22,
        minZoom: 2,
        zoomSnap: 0.5,
        wheelPxPerZoomLevel: 60,
      });

      addSatelliteHybrid(map, { withLabels: true, maxZoom: 22, withControl: true });

      if (customerBoundary) {
        boundaryLayerRef.current = drawPropertyBoundary(map, customerBoundary.geojson);
        if (fitToBoundary && !selectedLocation) {
          const b = geoJsonBounds(customerBoundary.geojson);
          if (b) map.fitBounds(b.pad(0.18), { animate: false });
        }
      }

      map.on("click", async (e) => {
        const selectionRevision = ++selectionRevisionRef.current;
        const { lat, lng } = e.latlng;
        if (markerRef.current) {
          map.removeLayer(markerRef.current);
        }
        const marker = L.marker([lat, lng]).addTo(map);
        markerRef.current = marker;
        // Dismiss the company-fallback notice immediately — before the async
        // reverse-geocode and before the parent updates selectedLocation.
        setHasPinDropped(true);
         const address = canUseNetwork()
           ? await reverseGeocode(lat, lng)
           : undefined;
          if (selectionRevision !== selectionRevisionRef.current) return;
          onLocationSelect({
            lat,
            lng,
            ...(address ? { address } : {}),
            source: "manual",
            accuracyM: null,
            gpsError: gpsFailureRef.current,
          });
      });

      if (selectedLocation) {
        const marker = L.marker([selectedLocation.lat, selectedLocation.lng]).addTo(map);
        markerRef.current = marker;
      }

      centeredByRef.current = centeredBy;
      mapInstanceRef.current = map;
      setUsedCompanyFallback(centeredBy === "company");
      setIsLoading(false);

      if ('geolocation' in navigator) {
        const wId = navigator.geolocation.watchPosition(
          (position) => {
            updateLiveLocationMarker(position.coords.latitude, position.coords.longitude);
          },
          (error) => {
            if (error.code === error.PERMISSION_DENIED) {
              setLocationError("Location access denied. Enable it in browser settings for live tracking.");
            }
          },
          { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
        );
        watchIdRef.current = wId;
      }
    };

    initializeMap();

    return () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }
      liveLocationMarkerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reactive company-fallback re-center: fires when companyFallbackAddress or
  // boundaryResolved changes after the map has already mounted.
  //
  // This handles the React Query cache-miss scenario where the company profile
  // (and/or the boundary query) resolves after the map has already opened.
  //
  // All guards must pass before geocoding is attempted:
  //   - Map is mounted
  //   - Initial centering used the regional fallback (centeredByRef === 'regional')
  //   - Boundary lookup has definitively settled (boundaryResolved === true)
  //     → prevents applying company fallback while boundary is still in-flight
  //   - No boundary was found (customerBoundary is falsy)
  //   - No pin has been set (selectedLocation is falsy)
  //   - companyFallbackAddress is a non-empty string
  //
  // After the async geocode, re-checks are performed to handle races
  // (e.g. a boundary arriving while geocoding was in progress).
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;
    if (centeredByRef.current !== "regional") return;
    if (!boundaryResolved) return;          // boundary query still in-flight
    if (customerBoundary) return;           // boundary exists — never consult company
    if (hasCustomerAddress) return;         // customer has an address — never consult company
    if (!companyFallbackAddress) return;
    if (selectedLocation) return;
    if (!canUseNetwork()) return;

    let cancelled = false;
    forwardGeocode(companyFallbackAddress).then((coords) => {
      if (cancelled) return;
      if (!coords) return;
      const liveMap = mapInstanceRef.current;
      if (!liveMap) return;
      // Re-check guards after async gap in case boundary or pin arrived meanwhile
      if (centeredByRef.current !== "regional") return;
      if (markerRef.current) return;        // pin was dropped while geocoding
      // customerBoundary captured via closure; check ref would be better but the
      // boundary effect will fitBounds independently and clear usedCompanyFallback.
      liveMap.setView(coords, 12, { animate: true });
      centeredByRef.current = "company";
      setUsedCompanyFallback(true);
    });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyFallbackAddress, boundaryResolved]);

  // When a boundary arrives after the company fallback was already applied,
  // suppress the yellow notice and update centeredByRef so the reactive effect
  // above remains a no-op even if companyFallbackAddress changes later.
  useEffect(() => {
    if (customerBoundary && usedCompanyFallback) {
      setUsedCompanyFallback(false);
      centeredByRef.current = "boundary";
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!customerBoundary]);

  // Sync the pin marker whenever the parent changes `selectedLocation` externally.
  // Also keeps hasPinDropped in sync so the yellow notice correctly re-appears
  // when a pin is cleared from outside (e.g. a "Reset" action in the wizard).
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;
    if (selectedLocation) {
      const { lat, lng } = selectedLocation;
      if (markerRef.current) {
        markerRef.current.setLatLng([lat, lng]);
      } else {
        markerRef.current = L.marker([lat, lng]).addTo(map);
      }
      map.flyTo([lat, lng], Math.max(map.getZoom(), 18), { duration: 0.8 });
      setHasPinDropped(true);
    } else {
      if (markerRef.current) {
        map.removeLayer(markerRef.current);
        markerRef.current = null;
      }
      setHasPinDropped(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLocation?.lat, selectedLocation?.lng]);

  // Swap boundary overlay when it changes (e.g. switching customer).
  // If no pin is set, also re-fit to the new boundary.
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;
    if (boundaryLayerRef.current) {
      map.removeLayer(boundaryLayerRef.current);
      boundaryLayerRef.current = null;
    }
    if (customerBoundary) {
      boundaryLayerRef.current = drawPropertyBoundary(map, customerBoundary.geojson);
      if (!selectedLocation) {
        const b = geoJsonBounds(customerBoundary.geojson);
        if (b) map.fitBounds(b.pad(0.18), { animate: true, duration: 0.6 });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerBoundary?.geojson]);

  const resetToDefault = () => {
    const map = mapInstanceRef.current;
    if (!map) return;
    if (markerRef.current) {
      map.removeLayer(markerRef.current);
      markerRef.current = null;
    }
    if (customerBoundary) {
      const b = geoJsonBounds(customerBoundary.geojson);
      if (b) map.fitBounds(b.pad(0.18), { animate: true });
      return;
    }
    map.setView(FALLBACK_CENTER, FALLBACK_ZOOM);
  };

  const handleUseMyLocation = async () => {
    const selectionRevision = ++selectionRevisionRef.current;
    setIsLocating(true);
    setLocationError(null);

    if (!('geolocation' in navigator)) {
      const gpsError = "not_supported";
      gpsFailureRef.current = gpsError;
      setLocationError("Location is not supported by your browser.");
      setIsLocating(false);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const { latitude: lat, longitude: lng } = position.coords;
        const map = mapInstanceRef.current;
        if (map) {
          map.flyTo([lat, lng], 20, { duration: 1 });
          if (markerRef.current) {
            map.removeLayer(markerRef.current);
          }
          const marker = L.marker([lat, lng]).addTo(map);
          markerRef.current = marker;
        }
        const address = canUseNetwork()
          ? await reverseGeocode(lat, lng)
          : undefined;
        if (selectionRevision !== selectionRevisionRef.current) {
          setIsLocating(false);
          return;
        }
        gpsFailureRef.current = null;
        onLocationSelect({
          lat,
          lng,
          ...(address ? { address } : {}),
          source: "gps",
          accuracyM: Number.isFinite(position.coords.accuracy)
            ? position.coords.accuracy
            : null,
          gpsError: null,
        });
        setIsLocating(false);
      },
      (error) => {
        if (selectionRevision !== selectionRevisionRef.current) return;
        const gpsError =
          error.code === error.PERMISSION_DENIED
            ? "permission_denied"
            : error.code === error.POSITION_UNAVAILABLE
              ? "position_unavailable"
              : error.code === error.TIMEOUT
                ? "timeout"
                : "unknown";
        gpsFailureRef.current = gpsError;
        switch (error.code) {
          case error.PERMISSION_DENIED:
            setLocationError(
              "Location permission was denied. Please enable it in your browser settings. " +
              "You can still click on the map to set your location manually."
            );
            break;
          case error.POSITION_UNAVAILABLE:
            setLocationError("Your location could not be determined.");
            break;
          case error.TIMEOUT:
            setLocationError("Location request timed out. Please try again.");
            break;
          default:
            setLocationError("Unable to get your location.");
        }
        setIsLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  };

  // Notice is hidden immediately when the tech drops a pin (hasPinDropped)
  // and also suppressed if a boundary exists (it may have arrived after the
  // company fallback was applied and centeredByRef was reset).
  const showCompanyFallbackNotice = usedCompanyFallback && !hasPinDropped && !customerBoundary;

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center justify-between flex-wrap gap-2">
          <span className="flex items-center gap-2">
            <MapPin className="w-5 h-5 text-blue-600" />
            Work Location
          </span>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={handleUseMyLocation}
              disabled={isLocating || isLoading}
              className="bg-blue-600 hover:bg-blue-700 text-white"
            >
              {isLocating ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Navigation className="w-4 h-4 mr-2" />
              )}
              {isLocating ? "Locating..." : "I’m here"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={resetToDefault}
              disabled={isLoading}
            >
              <RotateCcw className="w-4 h-4 mr-2" />
              {hasBoundary ? "Reset to Property" : "Reset to Default"}
            </Button>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          <p className="text-sm text-gray-600">
            Click on the map to select the exact work location, or use your current location
          </p>

          {locationError && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3">
              <p className="text-sm text-red-800">{locationError}</p>
            </div>
          )}

          {selectedLocation && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
              <p className="text-sm font-medium text-blue-900">Selected Location:</p>
              <p className="text-sm text-blue-800 mt-1">
                {selectedLocation.address || `${selectedLocation.lat.toFixed(6)}, ${selectedLocation.lng.toFixed(6)}`}
              </p>
            </div>
          )}

          <div className="relative">
            <div
              ref={mapRef}
              className="w-full h-64 rounded-lg border border-gray-300"
              style={{ minHeight: "256px" }}
            />
            {isLoading && (
              <div className="absolute inset-0 bg-white bg-opacity-75 flex items-center justify-center rounded-lg">
                <div className="flex items-center gap-2 text-gray-600">
                  <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
                  Loading map...
                </div>
              </div>
            )}
          </div>

          {showCompanyFallbackNotice && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
              <p className="text-sm text-yellow-800">
                No address or property boundary on file for this customer — map is centered on your
                company address. Add an address or boundary to the customer profile for accurate
                centering.
              </p>
            </div>
          )}
          {children}
        </div>
      </CardContent>
    </Card>
  );
}
