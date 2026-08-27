/**
 * Customer-facing "Irrigation System Profile" PDF.
 *
 * Contains: company logo/header, property name, prepared date.
 * Per controller: details block, each active program (days/start times/
 * seasonal %), and the auto run-time schedule table computed via
 * computeRunSchedule. Inactive controllers or zones are flagged with a
 * "Needs Attention" marker. No internal cost data.
 *
 * See also: wet-check-report-pdf.ts (pattern reference).
 */
import puppeteer from 'puppeteer-core';
import type { Company } from '@workspace/db';
import type {
  IrrigationController,
  IrrigationProgram,
  IrrigationProfileZone,
} from '@workspace/db/schema';
import { buildPdfSiteMetadata, pdfSiteMetadataLines } from './pdf-site-metadata';
import { resolveChromiumExecutable } from './chromium-resolver';
import { fetchLogoAsBase64 } from './pdf-generator';
import { VRT_LOGO_DATA_URI } from './assets/vrt-logo.js';
import { IRRIGOPRO_LOGO_DATA_URI } from './assets/irrigopro-logo.js';
import {
  computeRunSchedule,
  minutesToTime,
  type ScheduleInputProgram,
  type ScheduleInputZone,
} from '@workspace/shared';

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

async function extractAccentFromLogo(
  dataUri: string,
): Promise<{ accent: string; accentDark: string }> {
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
  const d = value instanceof Date ? value : new Date(value as string);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function formatZoneType(t: string): string {
  const map: Record<string, string> = {
    pop_up_spray: 'Pop-up Spray',
    rotor: 'Rotor',
    drip: 'Drip',
    netafim: 'Netafim',
    bubbler: 'Bubbler',
    other: 'Other',
  };
  return map[t] ?? t;
}

// ─── Public types ─────────────────────────────────────────────────────────────

export type ControllerWithDetail = IrrigationController & {
  programs: IrrigationProgram[];
  zones: IrrigationProfileZone[];
};

export interface IrrigationProfilePdfOptions {
  company?: Company | null;
  logoDataUri?: string | null;
  accentColor?: string;
  accentDark?: string;
  propertyAddress?: string | null;
}

// ─── Schedule rendering ───────────────────────────────────────────────────────

function renderScheduleTable(
  schedule: ReturnType<typeof computeRunSchedule>,
  _accent: string,
): string {
  if (schedule.length === 0) {
    return '<p class="no-data">No active programs with zones assigned.</p>';
  }

  return schedule
    .map(
      (ps) => `
    <div class="schedule-block">
      <div class="schedule-header">
        Program ${esc(ps.programName)} &mdash; Start ${esc(ps.startTime)}
        ${ps.wateringDays.length > 0 ? `<span class="schedule-days">(${esc(ps.wateringDays.join(', '))})</span>` : ''}
      </div>
      ${
        ps.entries.length === 0
          ? '<p class="no-data">No active zones in this program.</p>'
          : `
      <table class="schedule-table">
        <thead>
          <tr>
            <th>Zone #</th>
            <th>Name</th>
            <th>Type</th>
            <th class="text-right">Start</th>
            <th class="text-right">End</th>
            <th class="text-right">Runtime</th>
            <th class="text-center">Override</th>
          </tr>
        </thead>
        <tbody>
          ${ps.entries
            .map(
              (e) => `
            <tr class="${e.isOverride ? 'override-row' : ''}">
              <td>${esc(e.zoneNumber)}</td>
              <td>${esc(e.zoneName)}</td>
              <td class="muted">${esc(formatZoneType(e.zoneType))}</td>
              <td class="text-right mono">${esc(minutesToTime(e.expectedStartMinutes))}</td>
              <td class="text-right mono">${esc(minutesToTime(e.expectedEndMinutes))}</td>
              <td class="text-right">${esc(e.adjustedRunTimeMinutes)} min</td>
              <td class="text-center">${
                e.isOverride
                  ? `<span class="override-label">Override</span>`
                  : '<span class="dash">&mdash;</span>'
              }</td>
            </tr>`,
            )
            .join('')}
        </tbody>
      </table>`
      }
    </div>`,
    )
    .join('');
}

// ─── Controller block ─────────────────────────────────────────────────────────

function renderControllerBlock(
  ctrl: ControllerWithDetail,
  accent: string,
  _accentDark: string,
): string {
  const isInactive = !ctrl.isActive;

  const schedulePrograms: ScheduleInputProgram[] = ctrl.programs.map((p: any) => ({
    id: p.id,
    name: p.name,
    wateringDays: p.wateringDays,
    startTimes: p.startTimes,
    seasonalAdjustPct: p.seasonalAdjustPct,
    isActive: p.isActive,
    sortOrder: p.sortOrder,
  }));
  const scheduleZones: ScheduleInputZone[] = ctrl.zones.map((z: any) => ({
    id: z.id,
    programId: z.programId,
    zoneNumber: z.zoneNumber,
    name: z.name,
    zoneType: z.zoneType,
    runTimeMinutes: z.runTimeMinutes,
    zoneOrder: z.zoneOrder,
    isActive: z.isActive,
    overrideStartTime: z.overrideStartTime,
    overrideDays: z.overrideDays,
  }));
  const schedule = computeRunSchedule(schedulePrograms, scheduleZones);

  const activePrograms = ctrl.programs.filter((p: any) => p.isActive);
  const inactiveZones = ctrl.zones.filter((z: any) => !z.isActive);
  const controllerSite = buildPdfSiteMetadata({
    branch: ctrl.branchName,
    controllerLabel: ctrl.letter,
    controllerLocation: ctrl.location,
  });

  const detailPairs: [string, string][] = [
    ...pdfSiteMetadataLines(controllerSite)
      .filter((line) => line.label !== 'Location')
      .map((line): [string, string] => [line.label, line.value]),
    ctrl.brand ? ['Brand', ctrl.brand] : null,
    ctrl.model ? ['Model', ctrl.model] : null,
    ctrl.totalZones != null ? ['Total Zones', String(ctrl.totalZones)] : null,
    ctrl.lastUpdatedAt
      ? [
          'Last Updated',
          fmtDate(ctrl.lastUpdatedAt) +
            (ctrl.lastUpdatedByName ? ` by ${ctrl.lastUpdatedByName}` : ''),
        ]
      : null,
  ].filter((x): x is [string, string] => x !== null);

  return `
  <div class="controller-block${isInactive ? ' controller-inactive' : ''}">
    <div class="controller-header">
      <div class="controller-title">
        <span class="controller-name">${esc(ctrl.name)}</span>
        ${isInactive ? '<span class="attention-badge">&#9888; Needs Attention &mdash; Inactive</span>' : ''}
      </div>
    </div>

    ${
      detailPairs.length > 0
        ? `<div class="controller-details">
        ${detailPairs
          .map(
            ([k, v]) => `<div class="detail-row"><span class="detail-k">${esc(k)}</span><span class="detail-v">${esc(v)}</span></div>`,
          )
          .join('')}
      </div>`
        : ''
    }

    ${
      ctrl.notes
        ? `<div class="notes-block">${esc(ctrl.notes)}</div>`
        : ''
    }

    ${
      activePrograms.length > 0
        ? `
    <div class="section-label">Programs</div>
    ${activePrograms
      .map((prog: any) => {
        const progZones = ctrl.zones.filter((z: any) => z.programId === prog.id && z.isActive);
        return `
      <div class="program-block">
        <div class="program-header">Program ${esc(prog.name)}</div>
        <div class="program-meta">
          ${(prog.wateringDays ?? []).length > 0 ? `<span class="meta-pill">Days: ${esc((prog.wateringDays ?? []).join(', '))}</span>` : ''}
          ${(prog.startTimes ?? []).length > 0 ? `<span class="meta-pill">Start: ${esc((prog.startTimes ?? []).join(', '))}</span>` : ''}
          <span class="meta-pill">Seasonal: ${esc(prog.seasonalAdjustPct)}%</span>
          <span class="meta-pill">${esc(progZones.length)} active zone${progZones.length !== 1 ? 's' : ''}</span>
        </div>
      </div>`;
      })
      .join('')}`
        : ''
    }

    ${
      inactiveZones.length > 0
        ? `
    <div class="section-label attention-section-label">Zones Needing Attention</div>
    <div class="attention-zones">
      ${inactiveZones
        .map(
          (z: any) => `
        <div class="attention-zone">
          <span class="zone-ref">${esc([controllerSite.controller, `Zone ${z.zoneNumber}`].filter(Boolean).join(' · '))}</span>
          <span class="attention-badge-sm">&#9888; Inactive</span>
          ${z.name ? ` &mdash; ${esc(z.name)}` : ''}
          ${z.notes ? `<span class="zone-note"> &middot; ${esc(z.notes)}</span>` : ''}
        </div>`,
        )
        .join('')}
    </div>`
        : ''
    }

    ${
      schedule.length > 0
        ? `
    <div class="section-label">Auto Run-Time Schedule</div>
    ${renderScheduleTable(schedule, accent)}`
        : ''
    }
  </div>`;
}

// ─── Public HTML builder (exported for tests) ─────────────────────────────────

export function buildIrrigationProfileReportHtml(
  controllers: ControllerWithDetail[],
  customerName: string,
  opts: IrrigationProfilePdfOptions = {},
): string {
  const accent = opts.accentColor || DEFAULT_BRAND_COLOR;
  const accentDark = opts.accentDark || DEFAULT_BRAND_DARK;
  const company = opts.company;
  const companyName = company?.name ?? 'IrrigoPro';
  const companyLines = [company?.address, company?.phone, company?.email].filter(
    Boolean,
  ) as string[];
  const today = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const logoBlock = opts.logoDataUri
    ? `<img src="${opts.logoDataUri}" alt="${esc(companyName)}" class="logo" />`
    : '';

  const inactiveControllerCount = controllers.filter((c: any) => !c.isActive).length;
  const inactiveZoneCount = controllers.reduce(
    (n, c: any) => n + c.zones.filter((z: any) => !z.isActive).length,
    0,
  );
  const attentionCount = inactiveControllerCount + inactiveZoneCount;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>Irrigation System Profile &mdash; ${esc(customerName)}</title>
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

  .prop-meta { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px 20px; margin-bottom: 18px; }
  .prop-meta .pm-k { color: #6b7280; text-transform: uppercase; font-size: 9px; letter-spacing: 0.06em; margin-bottom: 1px; }
  .prop-meta .pm-v { color: #111827; font-weight: 600; font-size: 11px; }

  .attention-banner { background: #fff7ed; border: 1px solid #fed7aa; border-radius: 6px; padding: 10px 14px; margin-bottom: 16px; font-size: 10.5px; color: #92400e; }

  .controller-block { border: 1px solid #e5e7eb; border-radius: 8px; padding: 14px 16px; margin-bottom: 16px; page-break-inside: avoid; }
  .controller-inactive { border-color: #fca5a5; background: #fff7f7; }
  .controller-header { margin-bottom: 10px; }
  .controller-title { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .controller-name { font-size: 14px; font-weight: 700; color: ${accentDark}; }
  .attention-badge { display: inline-block; font-size: 9px; font-weight: 600; color: #991b1b; background: #fee2e2; border-radius: 999px; padding: 2px 10px; text-transform: uppercase; letter-spacing: 0.04em; }
  .attention-badge-sm { display: inline-block; font-size: 9px; font-weight: 600; color: #991b1b; background: #fee2e2; border-radius: 999px; padding: 1px 6px; }

  .controller-details { display: flex; flex-wrap: wrap; gap: 6px 20px; margin-bottom: 10px; }
  .detail-row { display: flex; gap: 5px; align-items: baseline; }
  .detail-k { color: #6b7280; font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.05em; white-space: nowrap; }
  .detail-v { color: #111827; font-weight: 500; font-size: 10.5px; }
  .notes-block { font-size: 10.5px; color: #4b5563; font-style: italic; margin-bottom: 8px; border-left: 2px solid #e5e7eb; padding-left: 8px; }

  .section-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: ${accentDark}; border-bottom: 2px solid ${accent}; padding-bottom: 3px; margin-bottom: 8px; margin-top: 12px; }
  .attention-section-label { color: #991b1b; border-bottom-color: #fca5a5; }

  .program-block { border: 1px solid #dbeafe; border-radius: 6px; padding: 8px 12px; margin-bottom: 6px; background: #eff6ff; }
  .program-header { font-size: 11px; font-weight: 600; color: ${accentDark}; margin-bottom: 4px; }
  .program-meta { display: flex; flex-wrap: wrap; gap: 4px; }
  .meta-pill { display: inline-block; background: white; border: 1px solid #bfdbfe; border-radius: 999px; padding: 1px 8px; font-size: 9.5px; color: #1e40af; }

  .attention-zones { margin-bottom: 6px; }
  .attention-zone { display: flex; align-items: baseline; gap: 6px; padding: 4px 0; font-size: 10.5px; border-bottom: 1px solid #fee2e2; }
  .attention-zone:last-child { border-bottom: none; }
  .zone-ref { font-weight: 600; color: ${accentDark}; }
  .zone-note { color: #6b7280; font-style: italic; }

  .schedule-block { margin-bottom: 10px; }
  .schedule-header { font-size: 10.5px; font-weight: 600; color: ${accentDark}; margin-bottom: 4px; }
  .schedule-days { font-size: 9.5px; font-weight: 400; color: #6b7280; margin-left: 4px; }
  .schedule-table { width: 100%; border-collapse: collapse; font-size: 10px; margin-top: 4px; }
  .schedule-table th { background: ${accent}; color: white; padding: 4px 8px; text-align: left; font-weight: 600; font-size: 9.5px; }
  .schedule-table td { padding: 4px 8px; border-bottom: 1px solid #e5e7eb; }
  .schedule-table .text-right { text-align: right; }
  .schedule-table .text-center { text-align: center; }
  .schedule-table .mono { font-family: monospace; font-size: 9.5px; }
  .schedule-table .muted { color: #6b7280; }
  .schedule-table .override-row { background: #fffbeb; }
  .schedule-table .override-label { font-size: 9px; color: #92400e; background: #fef3c7; border-radius: 999px; padding: 1px 6px; }
  .schedule-table .dash { color: #d1d5db; }
  .no-data { font-size: 10px; color: #9ca3af; font-style: italic; margin: 4px 0; }
</style>
</head>
<body>
  <div class="brand-bar">
    <div class="co">
      ${logoBlock}
      <div>
        <div class="co-name">${esc(companyName)}</div>
        ${companyLines.length ? `<div class="co-meta">${companyLines.map(esc).join(' &middot; ')}</div>` : ''}
      </div>
    </div>
    <div class="doc-meta">
      <div class="doc-label">System Profile</div>
      <div class="doc-title">Irrigation Report</div>
    </div>
  </div>

  <div class="prop-meta">
    <div><div class="pm-k">Property</div><div class="pm-v">${esc(customerName)}</div></div>
    ${opts.propertyAddress ? `<div><div class="pm-k">Address</div><div class="pm-v">${esc(opts.propertyAddress)}</div></div>` : '<div></div>'}
    <div><div class="pm-k">Prepared</div><div class="pm-v">${esc(today)}</div></div>
  </div>

  ${
    attentionCount > 0
      ? `<div class="attention-banner">
    &#9888; ${esc(attentionCount)} item${attentionCount !== 1 ? 's' : ''} require${attentionCount === 1 ? 's' : ''} attention &mdash; see flagged controllers and zones below.
  </div>`
      : ''
  }

  ${
    controllers.length === 0
      ? '<p style="color:#9ca3af;font-style:italic;font-size:11px;">No controllers recorded for this property.</p>'
      : controllers.map((ctrl) => renderControllerBlock(ctrl, accent, accentDark)).join('')
  }
</body>
</html>`;
}

// ─── Footer ───────────────────────────────────────────────────────────────────

function footerTemplate(companyName: string): string {
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
  <span>${esc(companyName)} &mdash; Irrigation System Profile</span>
  <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
</div>`;
}

// ─── Public render function ───────────────────────────────────────────────────

export async function renderIrrigationProfilePdf(
  customerName: string,
  controllers: ControllerWithDetail[],
  opts: IrrigationProfilePdfOptions = {},
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

  const html = buildIrrigationProfileReportHtml(controllers, customerName, {
    ...opts,
    logoDataUri,
    accentColor: accentColor || DEFAULT_BRAND_COLOR,
    accentDark: accentDark || DEFAULT_BRAND_DARK,
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
      footerTemplate: footerTemplate(companyName),
      margin: { top: '0.6in', right: '0.5in', bottom: '0.85in', left: '0.5in' },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
