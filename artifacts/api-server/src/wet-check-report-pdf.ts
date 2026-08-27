/**
 * Customer-facing "System Inspection — Wet Check Report" PDF.
 *
 * This is a condition-only report: no labor hours, PSI/GPM, pricing, or
 * internal workflow status. It is safe to send directly to the customer.
 *
 * See also: wet-check-pdf.ts (internal back-office record, unchanged).
 */
import puppeteer from 'puppeteer-core';
import { readFileSync, existsSync } from 'fs';
import { join, basename } from 'path';
import type { Company } from '@workspace/db';
import type {
  WetCheckWithDetails,
  WetCheckZoneRecord,
  WetCheckFinding,
  WetCheckPhoto,
} from '@workspace/db/schema';
import { resolveChromiumExecutable } from './chromium-resolver';
import { fetchLogoAsBase64 } from './pdf-generator';
import { VRT_LOGO_DATA_URI } from './assets/vrt-logo.js';
import { IRRIGOPRO_LOGO_DATA_URI } from './assets/irrigopro-logo.js';
import { humanizeIssueType } from './inspection-issue-labels';
import { isEmptyZone } from './wet-check-zone-filter';
import { buildPdfSiteMetadata } from './pdf-site-metadata';
import { ObjectStorageService } from './objectStorage';
import { thumbPath } from './photo-pipeline';
import sharp from 'sharp';

const DEFAULT_BRAND_COLOR = '#1E5A99';
const DEFAULT_BRAND_DARK = '#143F6B';

const LOGO_PATH_PATTERNS = [
  /\/api\/public-objects\/company-logos\/(.+)/,
  /\/api\/company-logo\/(.+)/,
];

function resolveLogoToFetchableUrl(storedLogo: string): string {
  const port = process.env.PORT || '5000';
  const localBase = `http://localhost:${port}`;

  if (storedLogo.startsWith('http://') || storedLogo.startsWith('https://')) {
    let pathname: string;
    try {
      pathname = new URL(storedLogo).pathname;
    } catch {
      return storedLogo;
    }
    for (const pattern of LOGO_PATH_PATTERNS) {
      const match = pathname.match(pattern);
      if (match) return `${localBase}/api/company-logo/${match[1]}`;
    }
    return storedLogo;
  }
  if (storedLogo.startsWith('/api/')) return `${localBase}${storedLogo}`;
  if (storedLogo.startsWith('/')) return `${localBase}/api/company-logo${storedLogo}`;
  if (storedLogo.startsWith('company-logos/')) {
    return `${localBase}/api/company-logo/${storedLogo.replace('company-logos/', '')}`;
  }
  return `${localBase}/api/company-logo/${storedLogo}`;
}

async function extractAccentFromLogo(dataUri: string): Promise<{ accent: string; accentDark: string }> {
  try {
    const { Vibrant } = await import('node-vibrant/node');
    const base64Data = dataUri.replace(/^data:image\/[^;]+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    const palette = await Vibrant.from(buffer).getPalette();
    const swatch = palette.Vibrant || palette.DarkVibrant || palette.Muted;
    const darkSwatch = palette.DarkVibrant || palette.DarkMuted || swatch;
    if (!swatch) return { accent: DEFAULT_BRAND_COLOR, accentDark: DEFAULT_BRAND_DARK };
    const toHex = (s: { rgb: number[] }) =>
      '#' + s.rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
    return {
      accent: toHex(swatch),
      accentDark: darkSwatch ? toHex(darkSwatch) : DEFAULT_BRAND_DARK,
    };
  } catch {
    return { accent: DEFAULT_BRAND_COLOR, accentDark: DEFAULT_BRAND_DARK };
  }
}

// ─── Photo embedding ──────────────────────────────────────────────────────────

const REPORT_PHOTO_MAX_DIM = 320;
const REPORT_PHOTO_QUALITY = 65;
const PHOTO_LOAD_TIMEOUT_MS = 8000;
const FAILED_PHOTO_SENTINEL = '';

const _photoStorageService = new ObjectStorageService();

async function compressForReport(input: Buffer): Promise<Buffer> {
  return sharp(input, { failOn: 'none' })
    .rotate()
    .resize({ width: REPORT_PHOTO_MAX_DIM, height: REPORT_PHOTO_MAX_DIM, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: REPORT_PHOTO_QUALITY, mozjpeg: true })
    .toBuffer();
}

async function fetchPhotoAsDataUri(photoPath: string): Promise<string> {
  try {
    if (photoPath.startsWith('http')) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PHOTO_LOAD_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(photoPath, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) return FAILED_PHOTO_SENTINEL;
      const contentType = response.headers.get('content-type') || '';
      const mimeType = contentType.split(';')[0].trim().toLowerCase();
      if (!mimeType.startsWith('image/')) return FAILED_PHOTO_SENTINEL;
      const arrayBuffer = await response.arrayBuffer();
      const compressed = await compressForReport(Buffer.from(arrayBuffer));
      return `data:image/jpeg;base64,${compressed.toString('base64')}`;
    }

    let gcsKey = photoPath;
    if (photoPath.startsWith('/uploads/')) {
      const safeName = basename(photoPath);
      const localPath = join('./uploads', safeName);
      if (existsSync(localPath)) {
        const data = readFileSync(localPath);
        const compressed = await compressForReport(data);
        return `data:image/jpeg;base64,${compressed.toString('base64')}`;
      }
      return FAILED_PHOTO_SENTINEL;
    }
    if (gcsKey.startsWith('/api/photos/')) gcsKey = gcsKey.replace('/api/photos/', '');

    const thumbKey = thumbPath(gcsKey);
    let file = await _photoStorageService.searchPhotoObject(thumbKey);
    if (!file) file = await _photoStorageService.searchPhotoObject(gcsKey);
    if (!file) return FAILED_PHOTO_SENTINEL;

    const [metadata] = await file.getMetadata();
    const mimeType = (metadata.contentType || 'image/jpeg').split(';')[0].trim();
    if (!mimeType.startsWith('image/')) return FAILED_PHOTO_SENTINEL;

    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const stream = file.createReadStream();
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    const compressed = await compressForReport(Buffer.concat(chunks));
    return `data:image/jpeg;base64,${compressed.toString('base64')}`;
  } catch {
    return FAILED_PHOTO_SENTINEL;
  }
}

const PHOTO_BATCH_CONCURRENCY = 4;

async function preloadPhotoDataUris(urls: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const entries = [...new Set(urls.filter(Boolean))];
  for (let i = 0; i < entries.length; i += PHOTO_BATCH_CONCURRENCY) {
    const batch = entries.slice(i, i + PHOTO_BATCH_CONCURRENCY);
    const values = await Promise.all(batch.map(u => fetchPhotoAsDataUri(u)));
    batch.forEach((u, j) => { if (values[j]) result.set(u, values[j]); });
  }
  return result;
}

// ─── HTML helpers ─────────────────────────────────────────────────────────────

function esc(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtDate(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

// ─── Public HTML builder (exported for tests) ─────────────────────────────────

export interface WetCheckReportPdfOptions {
  company?: Company | null;
  logoDataUri?: string | null;
  accentColor?: string;
  accentDark?: string;
  /** Pre-loaded photo data URIs keyed by photo URL */
  photoDataUris?: Map<string, string>;
}

export interface HealthSummary {
  total: number;
  runningWell: number;
  needAttention: number;
  na: number;
  healthPct: number;
}

/** Derives health summary counts from zone records. Exported for tests. */
export function deriveHealthSummary(
  zoneRecords: (WetCheckZoneRecord & { findings: WetCheckFinding[] })[],
): HealthSummary {
  const total = zoneRecords.length;
  const runningWell = zoneRecords.filter(z => z.status === 'checked_ok').length;
  const needAttention = zoneRecords.filter(z => z.status === 'checked_with_issues').length;
  const na = zoneRecords.filter(z => z.status === 'not_applicable').length;
  const checked = runningWell + needAttention;
  const healthPct = checked > 0 ? Math.round((runningWell / checked) * 100) : 100;
  return { total, runningWell, needAttention, na, healthPct };
}

function renderPhotoGrid(photos: WetCheckPhoto[], photoDataUris: Map<string, string>): string {
  const loaded = photos
    .map(p => ({ caption: p.caption, dataUri: photoDataUris.get(p.url) ?? '' }))
    .filter(p => p.dataUri);

  if (!loaded.length) return '';
  return `
  <div class="photo-grid">
    ${loaded.map(p => `
      <div class="photo-cell">
        <img src="${p.dataUri}" alt="${esc(p.caption ?? 'Photo')}" class="photo-img" />
        ${p.caption ? `<div class="photo-caption">${esc(p.caption)}</div>` : ''}
      </div>`).join('')}
  </div>`;
}

function renderAttentionZone(
  zone: WetCheckZoneRecord & { findings: WetCheckFinding[] },
  photos: WetCheckPhoto[],
  photoDataUris: Map<string, string>,
): string {
  const findings = zone.findings ?? [];
  const zonePhotos = photos.filter(
    p => p.zoneRecordId === zone.id || (p.findingId != null && findings.some(f => f.id === p.findingId)),
  );

  const findingRows = findings.map(f => `
    <li class="finding-item">
      <span class="finding-dot">•</span>
      <span class="finding-label">${esc(humanizeIssueType(f.issueType))}</span>
      ${f.notes ? `<span class="finding-note"> — ${esc(f.notes)}</span>` : ''}
    </li>`).join('');

  return `
  <div class="attention-zone">
    <div class="attention-zone-header">
      <span class="zone-id">${esc(zone.controllerLetter)}-${esc(zone.zoneNumber)}</span>
      <span class="attention-badge">Needs Attention</span>
    </div>
    ${zone.notes ? `<div class="zone-notes">${esc(zone.notes)}</div>` : ''}
    ${findings.length > 0 ? `<ul class="finding-list">${findingRows}</ul>` : ''}
    ${renderPhotoGrid(zonePhotos, photoDataUris)}
  </div>`;
}

export function buildWetCheckReportHtml(
  wc: WetCheckWithDetails,
  opts: WetCheckReportPdfOptions = {},
): string {
  const accent = opts.accentColor || DEFAULT_BRAND_COLOR;
  const accentDark = opts.accentDark || DEFAULT_BRAND_DARK;
  const company = opts.company;
  const companyName = company?.name ?? 'IrrigoPro';
  const companyLines = [company?.address, company?.phone, company?.email].filter(Boolean) as string[];
  const photoDataUris = opts.photoDataUris ?? new Map<string, string>();

  const logoBlock = opts.logoDataUri
    ? `<img src="${opts.logoDataUri}" alt="${esc(companyName)}" class="logo" />`
    : '';

  const allZoneRecords = wc.zoneRecords ?? [];
  const zoneRecords = allZoneRecords.filter(z => !isEmptyZone(z));
  const allPhotos = wc.photos ?? [];
  const summary = deriveHealthSummary(zoneRecords);
  const site = buildPdfSiteMetadata({
    locationCandidates: [wc.propertyAddress],
    branch: wc.branchName,
  });
  const inspectedControllers = Array.from(
    new Set(zoneRecords.map((zone) => zone.controllerLetter).filter(Boolean)),
  ).map((letter) => `Clock ${letter}`).join(', ');

  const attentionZones = zoneRecords.filter(z => z.status === 'checked_with_issues');
  const runningWellZones = zoneRecords.filter(z => z.status === 'checked_ok');

  // Health bar colour
  const barColor = summary.healthPct >= 90 ? '#16a34a' : summary.healthPct >= 70 ? '#ca8a04' : '#dc2626';

  const attentionSection = attentionZones.length > 0
    ? `
  <div class="section-label">Zones Needing Attention</div>
  ${attentionZones.map(z => renderAttentionZone(z, allPhotos, photoDataUris)).join('')}`
    : '';

  const wellZoneLabels = runningWellZones
    .map(z => `${esc(z.controllerLetter)}-${esc(z.zoneNumber)}`)
    .join(', ');

  const runningWellSection = runningWellZones.length > 0
    ? `
  <div class="section-label" style="margin-top:18px;">Zones Running Well</div>
  <div class="running-well-block">
    <span class="check-icon">✓</span>
    <span class="well-zone-list">${wellZoneLabels}</span>
  </div>`
    : '';

  const closingLine = attentionZones.length > 0
    ? `Our team will be in touch to schedule the recommended repairs. Thank you for trusting us with your irrigation system.`
    : `Your irrigation system is in great shape — all zones checked out well. Thank you for trusting us with your system.`;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>System Inspection Report — ${esc(wc.customerName)}</title>
<style>
  @page { margin: 0.6in 0.5in 0.85in 0.5in; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; color: #1f2937; margin: 0; padding: 0; font-size: 11px; line-height: 1.5; }
  h1, h2, h3 { margin: 0; }

  .brand-bar { background: ${accent}; color: white; padding: 14px 18px; border-radius: 6px; display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: 18px; }
  .brand-bar .co { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .brand-bar .logo { max-height: 44px; max-width: 140px; background: white; padding: 4px 6px; border-radius: 4px; object-fit: contain; }
  .brand-bar .co-name { font-size: 16px; font-weight: 700; line-height: 1.2; }
  .brand-bar .co-meta { font-size: 10px; opacity: 0.92; line-height: 1.4; }
  .brand-bar .doc-meta { text-align: right; white-space: nowrap; }
  .brand-bar .doc-label { font-size: 10px; letter-spacing: 0.18em; opacity: 0.8; text-transform: uppercase; }
  .brand-bar .doc-title { font-size: 14px; font-weight: 700; line-height: 1.2; }

  .meta-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px 20px; margin-bottom: 18px; }
  .meta-item .k { color: #6b7280; text-transform: uppercase; font-size: 9px; letter-spacing: 0.06em; margin-bottom: 1px; }
  .meta-item .v { color: #111827; font-weight: 600; font-size: 11px; }

  .health-summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 18px; }
  .health-chip { border: 1px solid #e5e7eb; border-radius: 6px; padding: 8px 10px; text-align: center; }
  .health-chip .num { font-size: 22px; font-weight: 700; color: ${accentDark}; }
  .health-chip .lbl { font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; margin-top: 1px; }
  .health-chip.well .num { color: #16a34a; }
  .health-chip.attn .num { color: #dc2626; }

  .health-bar-wrap { margin-bottom: 18px; }
  .health-bar-bg { background: #e5e7eb; border-radius: 999px; height: 10px; overflow: hidden; }
  .health-bar-fill { height: 10px; border-radius: 999px; background: ${barColor}; width: ${summary.healthPct}%; }
  .health-bar-label { font-size: 10px; color: #6b7280; margin-top: 4px; text-align: right; }

  .section-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: ${accentDark}; border-bottom: 2px solid ${accent}; padding-bottom: 3px; margin-bottom: 10px; margin-top: 16px; }

  .attention-zone { border: 1px solid #fca5a5; border-radius: 6px; padding: 10px 12px; margin-bottom: 10px; background: #fff7f7; }
  .attention-zone-header { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
  .zone-id { font-size: 14px; font-weight: 700; color: ${accentDark}; }
  .attention-badge { display: inline-block; font-size: 9px; font-weight: 600; color: #991b1b; background: #fee2e2; border-radius: 999px; padding: 1px 8px; text-transform: uppercase; letter-spacing: 0.04em; }
  .zone-notes { font-size: 10px; color: #6b7280; margin-bottom: 6px; font-style: italic; }
  .finding-list { margin: 0 0 6px 0; padding: 0; list-style: none; }
  .finding-item { display: flex; align-items: baseline; gap: 5px; font-size: 10.5px; padding: 2px 0; }
  .finding-dot { color: ${accent}; font-size: 14px; line-height: 1; }
  .finding-label { font-weight: 600; color: #1f2937; }
  .finding-note { color: #6b7280; }

  .photo-grid { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .photo-cell { flex: 0 0 auto; }
  .photo-img { max-height: 120px; max-width: 160px; border-radius: 4px; object-fit: cover; border: 1px solid #e5e7eb; display: block; }
  .photo-caption { font-size: 9px; color: #9ca3af; margin-top: 2px; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .running-well-block { display: flex; align-items: flex-start; gap: 8px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 6px; padding: 10px 12px; }
  .check-icon { font-size: 16px; color: #16a34a; flex-shrink: 0; }
  .well-zone-list { font-size: 11px; color: #166534; font-weight: 500; line-height: 1.5; }

  .closing { margin-top: 20px; border-top: 1px solid #e5e7eb; padding-top: 14px; font-size: 11px; color: #6b7280; line-height: 1.6; }
</style>
</head>
<body>
  <div class="brand-bar">
    <div class="co">
      ${logoBlock}
      <div>
        <div class="co-name">${esc(companyName)}</div>
        ${companyLines.length ? `<div class="co-meta">${companyLines.map(esc).join(' · ')}</div>` : ''}
      </div>
    </div>
    <div class="doc-meta">
      <div class="doc-label">System Inspection</div>
      <div class="doc-title">Wet Check Report</div>
    </div>
  </div>

  <div class="meta-grid">
    <div class="meta-item"><div class="k">Customer</div><div class="v">${esc(wc.customerName)}</div></div>
    ${site.location ? `<div class="meta-item"><div class="k">Location</div><div class="v">${esc(site.location)}</div></div>` : ''}
    ${site.branch ? `<div class="meta-item"><div class="k">Branch</div><div class="v">${esc(site.branch)}</div></div>` : ''}
    <div class="meta-item"><div class="k">Technician</div><div class="v">${esc(wc.technicianName)}</div></div>
    <div class="meta-item"><div class="k">Inspection Date</div><div class="v">${esc(fmtDate(wc.startedAt))}</div></div>
    <div class="meta-item"><div class="k">Zones Inspected</div><div class="v">${summary.total}</div></div>
    ${inspectedControllers ? `<div class="meta-item"><div class="k">Controller / Clock</div><div class="v">${esc(inspectedControllers)}</div></div>` : ''}
    ${wc.weather ? `<div class="meta-item"><div class="k">Weather</div><div class="v">${esc(wc.weather)}</div></div>` : '<div class="meta-item"></div>'}
  </div>

  <div class="section-label">System Health Summary</div>
  <div class="health-summary">
    <div class="health-chip"><div class="num">${summary.total}</div><div class="lbl">Zones Checked</div></div>
    <div class="health-chip well"><div class="num">${summary.runningWell}</div><div class="lbl">Running Well</div></div>
    <div class="health-chip attn"><div class="num">${summary.needAttention}</div><div class="lbl">Need Attention</div></div>
    <div class="health-chip"><div class="num">${summary.na}</div><div class="lbl">Not Applicable</div></div>
  </div>
  <div class="health-bar-wrap">
    <div class="health-bar-bg"><div class="health-bar-fill"></div></div>
    <div class="health-bar-label">${summary.healthPct}% of active zones running well</div>
  </div>

  ${attentionSection}
  ${runningWellSection}

  <div class="closing">
    ${esc(closingLine)}
  </div>
</body>
</html>`;
}

// ─── Footer (shared "Powered by" pattern) ────────────────────────────────────

function footerTemplate(companyName: string, wetCheckId: number | null | undefined): string {
  const vrtLogoHtml = VRT_LOGO_DATA_URI
    ? `<img src="${VRT_LOGO_DATA_URI}" style="height:16px;" alt="VRT Sync" />`
    : `<span style="color:#9ca3af;">VRT Sync</span>`;
  const irrigoLogoHtml = IRRIGOPRO_LOGO_DATA_URI
    ? `<img src="${IRRIGOPRO_LOGO_DATA_URI}" style="height:14px;" alt="IrrigoPro" />`
    : '';
  return `
<div style="width:100%; font-size:8.5px; color:#9ca3af; padding:0 0.5in; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif; display:flex; justify-content:space-between; align-items:center; box-sizing:border-box;">
  <div style="display:flex;align-items:center;gap:6px;">
    ${irrigoLogoHtml}
    <span style="color:#9ca3af;font-size:8.5px;">Powered by</span>
    ${vrtLogoHtml}
  </div>
  <span>${esc(companyName)} &mdash; System Inspection Report</span>
  <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
</div>`;
}

// ─── Public render function ───────────────────────────────────────────────────

export async function renderWetCheckReportPdf(
  wc: WetCheckWithDetails,
  opts: WetCheckReportPdfOptions = {},
): Promise<Buffer> {
  let logoDataUri = opts.logoDataUri ?? null;
  let accentColor = opts.accentColor;
  let accentDark = opts.accentDark;

  if (!logoDataUri && opts.company?.logo) {
    try {
      const logoUrl = resolveLogoToFetchableUrl(opts.company.logo);
      logoDataUri = await fetchLogoAsBase64(logoUrl);
    } catch {
      logoDataUri = null;
    }
  }

  if (logoDataUri && (!accentColor || !accentDark)) {
    const extracted = await extractAccentFromLogo(logoDataUri);
    accentColor = accentColor || extracted.accent;
    accentDark = accentDark || extracted.accentDark;
  }

  // Pre-load all finding/zone photos as base64 data URIs
  const allPhotos = wc.photos ?? [];
  const photoDataUris = await preloadPhotoDataUris(allPhotos.map(p => p.url));

  const html = buildWetCheckReportHtml(wc, {
    ...opts,
    logoDataUri,
    accentColor: accentColor || DEFAULT_BRAND_COLOR,
    accentDark: accentDark || DEFAULT_BRAND_DARK,
    photoDataUris,
  });

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: resolveChromiumExecutable(),
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    const companyName = opts.company?.name ?? 'IrrigoPro';
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: footerTemplate(companyName, wc.id),
      margin: { top: '0.6in', right: '0.5in', bottom: '0.85in', left: '0.5in' },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
