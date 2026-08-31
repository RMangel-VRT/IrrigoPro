/**
 * Shared site-metadata contract for every PDF family (Task #1953, extended by
 * Task #1959).
 *
 * One place decides how a work site is described on a document: which address
 * wins, how a clock/zone reads, and how a dropped pin is formatted. Renderers
 * consume the normalized result and decide only how to lay it out — no PDF
 * family may re-derive these strings locally, or the families drift apart.
 *
 * Task #1959 additions:
 *   • Coordinates ("the dropped pin") normalize into display text + a map link.
 *   • Controller/zone accept MULTIPLE values, because techs record clock and
 *     zone per line item / per inspected zone rather than on the parent row.
 *     One distinct value reads singular ("Zone 3"); several read plural
 *     ("Zones 3, 5, 7").
 */

export interface PdfSiteMetadataInput {
  locationCandidates?: Array<string | null | undefined>;
  branch?: string | null;
  controllerLabel?: string | null;
  controllerLocation?: string | null;
  zoneNumber?: number | string | null;
  /**
   * Extra clock letters merged with `controllerLabel` — typically the letters
   * carried on individual line items or wet-check zone records.
   */
  controllerLabels?: Array<string | null | undefined>;
  /** Extra zone numbers merged with `zoneNumber`, from the same sources. */
  zoneNumbers?: Array<number | string | null | undefined>;
  latitude?: number | string | null;
  longitude?: number | string | null;
}

/** A dropped pin, normalized for display. Never partially populated. */
export interface PdfSitePin {
  latitude: number;
  longitude: number;
  /** Six-decimal display text, e.g. "39.739236, -104.990251". */
  coordinates: string;
  mapUrl: string;
}

export interface PdfSiteMetadata {
  location: string | null;
  branch: string | null;
  controller: string | null;
  controllerLocation: string | null;
  zone: string | null;
  pin: PdfSitePin | null;
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Trim, drop blanks, and de-duplicate while preserving first-seen order. */
function distinctClean(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = clean(raw);
    if (value === null || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * Clock letters read best alphabetically ("Clocks A, B"), case-insensitively
 * so a stray lowercase letter does not sort to the end.
 */
function sortControllerLabels(labels: string[]): string[] {
  return [...labels].sort((a, b) =>
    a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true }),
  );
}

/**
 * Zones are numeric in practice, so sort them numerically. Anything
 * non-numeric (a hand-typed label) keeps its original order and trails the
 * numbers rather than being dropped.
 */
function sortZoneTokens(tokens: string[]): string[] {
  const numeric: string[] = [];
  const other: string[] = [];
  for (const token of tokens) {
    if (/^-?\d+(\.\d+)?$/.test(token)) numeric.push(token);
    else other.push(token);
  }
  numeric.sort((a, b) => Number(a) - Number(b));
  return [...numeric, ...other];
}

function zoneToken(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const token = String(value).trim();
  return token ? token : null;
}

function toCoordinate(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Build the pin from a latitude/longitude pair. Returns null unless BOTH
 * coordinates are present and within valid geographic range — a half-captured
 * or out-of-range pin is worse than no pin, because it sends a crew somewhere
 * wrong.
 */
export function buildPdfSitePin(
  latitude: number | string | null | undefined,
  longitude: number | string | null | undefined,
): PdfSitePin | null {
  const lat = toCoordinate(latitude);
  const lng = toCoordinate(longitude);
  if (lat === null || lng === null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;

  const latText = lat.toFixed(6);
  const lngText = lng.toFixed(6);
  return {
    latitude: lat,
    longitude: lng,
    coordinates: `${latText}, ${lngText}`,
    mapUrl: `https://www.google.com/maps/search/?api=1&query=${latText},${lngText}`,
  };
}

export function buildPdfSiteMetadata(input: PdfSiteMetadataInput): PdfSiteMetadata {
  const location =
    input.locationCandidates?.map(clean).find((value): value is string => value !== null) ?? null;

  const controllerLabels = sortControllerLabels(
    distinctClean([input.controllerLabel, ...(input.controllerLabels ?? [])]),
  );
  const controller =
    controllerLabels.length === 0
      ? null
      : controllerLabels.length === 1
        ? `Clock ${controllerLabels[0]}`
        : `Clocks ${controllerLabels.join(', ')}`;

  const zoneTokens = sortZoneTokens(
    distinctClean([input.zoneNumber, ...(input.zoneNumbers ?? [])].map(zoneToken)),
  );
  const zone =
    zoneTokens.length === 0
      ? null
      : zoneTokens.length === 1
        ? `Zone ${zoneTokens[0]}`
        : `Zones ${zoneTokens.join(', ')}`;

  return {
    location,
    branch: clean(input.branch),
    controller,
    controllerLocation: clean(input.controllerLocation),
    zone,
    pin: buildPdfSitePin(input.latitude, input.longitude),
  };
}

export function pdfSiteMetadataLines(
  metadata: PdfSiteMetadata,
): Array<{ label: 'Location' | 'Branch' | 'Controller' | 'Zone'; value: string }> {
  const lines: Array<{ label: 'Location' | 'Branch' | 'Controller' | 'Zone'; value: string }> = [];
  if (metadata.location) lines.push({ label: 'Location', value: metadata.location });
  if (metadata.branch) lines.push({ label: 'Branch', value: metadata.branch });
  if (metadata.controller) {
    lines.push({
      label: 'Controller',
      value: metadata.controllerLocation
        ? `${metadata.controller} — ${metadata.controllerLocation}`
        : metadata.controller,
    });
  } else if (metadata.controllerLocation) {
    lines.push({ label: 'Controller', value: metadata.controllerLocation });
  }
  if (metadata.zone) lines.push({ label: 'Zone', value: metadata.zone });
  return lines;
}

export function pdfControllerZoneText(metadata: PdfSiteMetadata): string | null {
  return [metadata.controller, metadata.zone].filter(Boolean).join(' · ') || null;
}

/**
 * Per-line clock/zone label for a single line item, e.g. "Clock A · Zone 3".
 * Returns null when the item carries neither, so callers never emit an empty
 * tag or a dangling separator.
 */
export function pdfLineItemZoneLabel(
  controllerLetter: string | null | undefined,
  zoneNumber: number | string | null | undefined,
): string | null {
  const letter = clean(controllerLetter);
  const zone = zoneToken(zoneNumber);
  return [letter ? `Clock ${letter}` : null, zone ? `Zone ${zone}` : null]
    .filter(Boolean)
    .join(' · ') || null;
}
