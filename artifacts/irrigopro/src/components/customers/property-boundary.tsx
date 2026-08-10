import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Hexagon, Upload, Trash2, RefreshCw, AlertTriangle, Loader2, MapPin } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import {
  isBoundaryFile,
  parseBoundaryFile,
  hydrateStoredBoundary,
  type PropertyBoundary,
  type StoredBoundaryFields,
} from "@/lib/property-boundary";
import {
  drawPropertyBoundary,
  geoJsonBounds,
  ensureBoundaryStyles,
} from "@/lib/boundary-style";
import {
  addSatelliteHybrid,
} from "@/lib/leaflet-base-layers";
import type { Customer } from "@workspace/db/schema";

interface PropertyBoundarySectionProps {
  customer: Customer;
  userRole?: string;
}

// Mirror of `requireCustomerEditAccess` on the server. Keep these in sync —
// otherwise the UI shows edit affordances for roles that get 403 on save.
// TODO(roles): migrate to a capability from lib/shared/src/roles.ts (hasCapability). Inventory: docs/roles-migration-inventory.md
const EDIT_ROLES = new Set([
  "company_admin",
  "super_admin",
  "irrigation_manager",
]);

export function PropertyBoundarySection({ customer, userRole }: PropertyBoundarySectionProps) {
  const canEdit = !!userRole && EDIT_ROLES.has(userRole);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [preview, setPreview] = useState<PropertyBoundary | null>(null);
  const [parsing, setParsing] = useState(false);

  const { data: stored, isLoading } = useQuery<
    StoredBoundaryFields,
    Error,
    PropertyBoundary | null
  >({
    queryKey: [`/api/customers/${customer.id}/property-boundary`],
    select: (raw) => hydrateStoredBoundary(raw),
  });

  const saveMutation = useMutation({
    mutationFn: async (b: PropertyBoundary) => {
      return apiRequest(`/api/customers/${customer.id}/property-boundary`, "PUT", {
        propertyBoundary: JSON.stringify(b.geojson),
        propertyBoundaryKml: b.kml,
        propertyBoundaryFileName: b.fileName,
        propertyBoundaryCenterLat: String(b.centerLat),
        propertyBoundaryCenterLng: String(b.centerLng),
        propertyBoundaryZoom: b.zoom,
        propertyBoundaryAreaAcres: String(b.areaAcres.toFixed(4)),
      });
    },
    onSuccess: () => {
      toast({ title: "Boundary saved", description: "Property boundary updated." });
      setPreview(null);
      invalidateAll();
    },
    onError: (err: Error) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      return apiRequest(`/api/customers/${customer.id}/property-boundary`, "DELETE");
    },
    onSuccess: () => {
      toast({ title: "Boundary removed" });
      setPreview(null);
      invalidateAll();
    },
    onError: (err: Error) => {
      toast({ title: "Remove failed", description: err.message, variant: "destructive" });
    },
  });

  function invalidateAll() {
    queryClient.invalidateQueries({ queryKey: ["/api/customers"] });
    queryClient.invalidateQueries({ queryKey: [`/api/customers/${customer.id}`] });
    queryClient.invalidateQueries({
      queryKey: [`/api/customers/${customer.id}/property-boundary`],
    });
  }

  async function handleFile(file: File) {
    if (!isBoundaryFile(file)) {
      toast({
        title: "Unsupported file",
        description: "Please upload a .kml or .kmz file.",
        variant: "destructive",
      });
      return;
    }
    setParsing(true);
    try {
      const boundary = await parseBoundaryFile(file);
      setPreview(boundary);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to parse file";
      toast({ title: "Parse failed", description: msg, variant: "destructive" });
    } finally {
      setParsing(false);
    }
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  };

  const active = preview || stored;

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <div className="bg-purple-100 p-2 rounded-md">
            <Hexagon className="w-5 h-5 text-purple-600" />
          </div>
          Property Boundary
          {stored && !preview && (
            <Badge className="ml-2 bg-purple-100 text-purple-800 border-purple-200">Set</Badge>
          )}
          {preview && (
            <Badge className="ml-2 bg-amber-100 text-amber-800 border-amber-200">Preview</Badge>
          )}
        </CardTitle>
        {canEdit && stored && !preview && (
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
            >
              <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
              Replace
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-red-600 hover:text-red-700"
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
            >
              <Trash2 className="w-3.5 h-3.5 mr-1.5" />
              Remove
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <input
          ref={fileInputRef}
          type="file"
          accept=".kml,.kmz,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
            e.target.value = "";
          }}
        />

        {isLoading && (
          <div className="text-sm text-gray-500 flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        )}

        {!isLoading && !active && (
          canEdit ? (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`relative cursor-pointer rounded-xl border-2 border-dashed p-8 text-center transition
                ${dragOver
                  ? "border-purple-500 bg-purple-50"
                  : "border-purple-200 bg-gradient-to-br from-purple-50/60 via-white to-indigo-50/60 hover:border-purple-300"}`}
            >
              <div className="flex justify-center">
                <div className="bg-purple-100 p-3 rounded-full">
                  <Hexagon className="w-7 h-7 text-purple-600" />
                </div>
              </div>
              <h3 className="mt-3 text-sm font-semibold text-gray-900">
                Upload a property boundary
              </h3>
              <p className="mt-1 text-xs text-gray-600">
                Drag and drop a <code className="px-1 py-0.5 rounded bg-gray-100">.kml</code> or
                <code className="px-1 py-0.5 rounded bg-gray-100">.kmz</code> file, or click to
                browse.
              </p>
              {parsing && (
                <p className="mt-2 text-xs text-purple-600 flex items-center justify-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" /> Parsing…
                </p>
              )}
              <div className="mt-3 inline-flex items-center gap-1 text-[11px] uppercase tracking-wide text-purple-700">
                <Upload className="w-3 h-3" /> KML / KMZ
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-gray-200 bg-gray-50 p-6 text-center text-sm text-gray-600 flex items-center justify-center gap-2">
              <MapPin className="w-4 h-4 text-gray-400" />
              No property boundary on file.
            </div>
          )
        )}

        {active && (
          <div className="space-y-3">
            <BoundaryMap boundary={active} />
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat label="Acreage" value={`${active.areaAcres.toFixed(2)} ac`} />
              <Stat
                label="Centroid"
                value={`${active.centerLat.toFixed(5)}, ${active.centerLng.toFixed(5)}`}
              />
              <Stat label="Source" value={active.fileName || "—"} mono />
              <Stat label="Status" value={preview ? "Preview" : "Saved"} />
            </div>

            {preview && canEdit && (
              <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
                <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5" />
                <div className="flex-1 text-sm text-amber-800">
                  Preview only — click <strong>Save Boundary</strong> to persist this overlay
                  to all customer maps.
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setPreview(null)}
                  >
                    Discard
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    className="bg-purple-600 hover:bg-purple-700 text-white"
                    onClick={() => saveMutation.mutate(preview)}
                    disabled={saveMutation.isPending}
                  >
                    {saveMutation.isPending && (
                      <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                    )}
                    Save Boundary
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`text-sm font-medium text-gray-900 truncate ${mono ? "font-mono text-xs" : ""}`}>
        {value}
      </div>
    </div>
  );
}

function BoundaryMap({ boundary }: { boundary: PropertyBoundary }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const overlayRef = useRef<L.LayerGroup | null>(null);

  // Initialize map once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    ensureBoundaryStyles();
    const map = L.map(containerRef.current, {
      zoomControl: true,
      maxZoom: 22,
      minZoom: 3,
      preferCanvas: true,
    }).setView([boundary.centerLat, boundary.centerLng], boundary.zoom);
    mapRef.current = map;

    addSatelliteHybrid(map, { withLabels: true, maxZoom: 22, withControl: true });

    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      overlayRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Redraw boundary whenever it changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (overlayRef.current) {
      map.removeLayer(overlayRef.current);
      overlayRef.current = null;
    }
    overlayRef.current = drawPropertyBoundary(map, boundary.geojson);
    const bounds = geoJsonBounds(boundary.geojson);
    if (bounds) map.fitBounds(bounds.pad(0.18), { animate: false });
  }, [boundary.geojson]);

  const acres = useMemo(() => boundary.areaAcres.toFixed(2), [boundary.areaAcres]);

  return (
    <div className="relative rounded-xl overflow-hidden" style={{ background: "#0a0f1a" }}>
      <div ref={containerRef} className="w-full" style={{ height: "380px" }} />
      <div className="absolute top-3 left-3 z-[400] inline-flex items-center gap-2 rounded-full bg-black/60 backdrop-blur px-3 py-1 text-xs font-medium text-purple-200 border border-purple-400/40">
        <span
          className="inline-block w-2 h-2 rounded-full"
          style={{ background: "#B026FF", boxShadow: "0 0 8px #B026FF" }}
        />
        Property boundary · {acres} ac
      </div>
    </div>
  );
}
