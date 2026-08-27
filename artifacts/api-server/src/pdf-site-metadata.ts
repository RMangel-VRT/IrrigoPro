export interface PdfSiteMetadataInput {
  locationCandidates?: Array<string | null | undefined>;
  branch?: string | null;
  controllerLabel?: string | null;
  controllerLocation?: string | null;
  zoneNumber?: number | string | null;
}

export interface PdfSiteMetadata {
  location: string | null;
  branch: string | null;
  controller: string | null;
  controllerLocation: string | null;
  zone: string | null;
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function buildPdfSiteMetadata(input: PdfSiteMetadataInput): PdfSiteMetadata {
  const location =
    input.locationCandidates?.map(clean).find((value): value is string => value !== null) ?? null;
  const controllerLabel = clean(input.controllerLabel);
  const controller = controllerLabel ? `Clock ${controllerLabel}` : null;
  const zone =
    input.zoneNumber === null || input.zoneNumber === undefined || String(input.zoneNumber).trim() === ''
      ? null
      : `Zone ${String(input.zoneNumber).trim()}`;

  return {
    location,
    branch: clean(input.branch),
    controller,
    controllerLocation: clean(input.controllerLocation),
    zone,
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