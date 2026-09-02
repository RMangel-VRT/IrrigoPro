import puppeteer from 'puppeteer-core';
import QRCode from 'qrcode';
import { resolveChromiumExecutable } from './chromium-resolver';
import { VRT_LOGO_DATA_URI } from './assets/vrt-logo.js';
import { IRRIGOPRO_LOGO_DATA_URI } from './assets/irrigopro-logo.js';
import { readFileSync, existsSync } from 'fs';
import { join, basename } from 'path';
import type { PdfViewModel, PdfBrandColors } from './pdf-view-model';
import { DEFAULT_BRAND_COLORS } from './pdf-view-model';
import sharp from 'sharp';
import { ObjectStorageService } from './objectStorage';
import { thumbPath } from './photo-pipeline';
import {
  FAILED_PHOTO_SENTINEL,
  fetchLogoAsBase64,
  coverPage,
  ticketPageWO,
  ticketPageBS,
  ticketPageWCB,
  reconciliationPage,
  buildFullCSS,
  buildPdfWorkOrderSiteMetadata,
  buildPdfBillingSheetSiteMetadata,
  buildPdfWetCheckSiteMetadata,
} from './pdf-helpers';
import type { WcbZonePhotoGroupResolved } from './pdf-helpers';
import type { PdfWcbZonePhotoGroup } from './pdf-view-model';

export { fetchLogoAsBase64 };

const _objectStorageService = new ObjectStorageService();

const PDF_PHOTO_MAX_DIM = 300;
const PDF_PHOTO_QUALITY = 60;
export const PDF_PIN_QR_SIZE = 148;

export async function compressForPdf(input: Buffer): Promise<Buffer> {
  return sharp(input, { failOn: 'none' })
    .rotate()
    .resize({
      width: PDF_PHOTO_MAX_DIM,
      height: PDF_PHOTO_MAX_DIM,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: PDF_PHOTO_QUALITY, mozjpeg: true })
    .toBuffer();
}

/**
 * Fetch a photo as a data URI, loading directly from object storage (GCS) or local disk.
 * Avoids going through the authenticated HTTP route for server-side PDF generation.
 *
 * Photos are compressed to ~300px / JPEG q60 before base64-encoding so that
 * invoice detail PDFs stay well under email attachment limits.
 */
async function fetchPhotoAsDataUri(photoPath: string, _port: number): Promise<string> {
  const PHOTO_LOAD_TIMEOUT_MS = 8000;
  try {
    // Handle fully-qualified external URLs (e.g. old signed GCS URLs)
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
      const compressed = await compressForPdf(Buffer.from(arrayBuffer));
      return `data:image/jpeg;base64,${compressed.toString('base64')}`;
    }

    // Normalize path: strip leading /uploads/ for legacy paths
    let gcsKey = photoPath;
    if (photoPath.startsWith('/uploads/')) {
      // Legacy local file — serve from disk
      const safeName = basename(photoPath);
      const localPath = join('./uploads', safeName);
      if (existsSync(localPath)) {
        const data = readFileSync(localPath);
        const compressed = await compressForPdf(data);
        return `data:image/jpeg;base64,${compressed.toString('base64')}`;
      }
      return FAILED_PHOTO_SENTINEL;
    }

    // Strip /api/photos/ prefix if present
    if (gcsKey.startsWith('/api/photos/')) {
      gcsKey = gcsKey.replace('/api/photos/', '');
    }

    // Prefer the thumb variant (~400px JPEG) so the embedded image is
    // small enough to keep monthly report PDFs under email attachment
    // limits. Fall back to the base path for legacy photos that have not
    // been backfilled yet.
    const thumbKey = thumbPath(gcsKey);
    let file = await _objectStorageService.searchPhotoObject(thumbKey);
    if (!file) file = await _objectStorageService.searchPhotoObject(gcsKey);
    if (!file) return FAILED_PHOTO_SENTINEL;

    // Download as buffer
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
    const buffer = Buffer.concat(chunks);
    const compressed = await compressForPdf(buffer);
    return `data:image/jpeg;base64,${compressed.toString('base64')}`;
  } catch {
    return FAILED_PHOTO_SENTINEL;
  }
}

const PHOTO_BATCH_CONCURRENCY = 5;

export async function preloadPhotos(urls: string[], port: number): Promise<string[]> {
  const results: string[] = new Array(urls.length);
  for (let i = 0; i < urls.length; i += PHOTO_BATCH_CONCURRENCY) {
    const batch = urls.slice(i, i + PHOTO_BATCH_CONCURRENCY);
    const batchResults = await Promise.all(batch.map(url => fetchPhotoAsDataUri(url, port)));
    batchResults.forEach((r, j) => { results[i + j] = r; });
  }
  return results;
}

export interface PdfPinQrSource {
  mapUrl: string | null;
  invoiceNumber: string;
  ticketLabel: string;
}

/**
 * Generate a print-sized QR locally. The 2x source is rendered at 74px in the
 * PDF so Chromium can preserve sharp module edges without a network request.
 */
export async function generatePdfPinQrDataUri(mapUrl: string): Promise<string> {
  return QRCode.toDataURL(mapUrl, {
    type: 'image/png',
    width: PDF_PIN_QR_SIZE,
    errorCorrectionLevel: 'M',
    margin: 1,
  });
}

/**
 * Resolve every ticket's QR independently and concurrently. A missing pin is
 * intentionally a no-op; an individual generator failure must not prevent the
 * rest of the invoice packet from rendering.
 */
export async function preloadPinQrs(
  sources: PdfPinQrSource[],
  generateQr: (mapUrl: string) => Promise<string> = generatePdfPinQrDataUri,
): Promise<Array<string | null>> {
  return Promise.all(sources.map(async source => {
    if (!source.mapUrl) return null;
    try {
      return await generateQr(source.mapUrl);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(
        `[PDF] Invoice ${source.invoiceNumber}: ${source.ticketLabel} pin QR generation failed — ${detail}`,
      );
      return null;
    }
  }));
}

/**
 * Task #843 — Convert URL-based zone photo groups into data-URI-based groups
 * for inline rendering in the WCB ticket PDF.
 */
async function resolveZonePhotoGroups(
  groups: PdfWcbZonePhotoGroup[],
  port: number,
  invoiceNumber: string,
  billingNumber: string,
): Promise<WcbZonePhotoGroupResolved[]> {
  const resolved: WcbZonePhotoGroupResolved[] = [];
  for (const g of groups) {
    const zonePhotoDataUris = g.zonePhotoUrls.length > 0
      ? await preloadPhotos(g.zonePhotoUrls, port)
      : [];

    const findingGroups: WcbZonePhotoGroupResolved['findingGroups'] = [];
    for (const fg of g.findingGroups) {
      const photoDataUris = fg.photoUrls.length > 0
        ? await preloadPhotos(fg.photoUrls, port)
        : [];
      findingGroups.push({ findingId: fg.findingId, issueDisplayLabel: fg.issueDisplayLabel, photoDataUris });
    }

    const failCount = [...zonePhotoDataUris, ...findingGroups.flatMap(fg => fg.photoDataUris)]
      .filter(u => u === FAILED_PHOTO_SENTINEL).length;
    if (failCount > 0) {
      console.warn(`[PDF] Invoice ${invoiceNumber}: WC Billing ${billingNumber} zone ${g.zoneLabel} — ${failCount} photo(s) failed to load`);
    }

    resolved.push({ zoneLabel: g.zoneLabel, zonePhotoDataUris, findingGroups });
  }
  return resolved;
}

function getChromiumPath(): string {
  return resolveChromiumExecutable();
}

export class PDFGenerator {
  static async generateInvoicePDF(invoiceHtmlPath: string): Promise<Buffer> {
    const browser = await puppeteer.launch({
      headless: true,
      executablePath: getChromiumPath(),
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
      const page = await browser.newPage();
      const htmlContent = readFileSync(invoiceHtmlPath, 'utf-8');
      await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' },
      });
      return Buffer.from(pdf);
    } finally {
      await browser.close();
    }
  }

  static async generateInvoicePDFFromUrl(url: string): Promise<Buffer> {
    const browser = await puppeteer.launch({
      headless: true,
      executablePath: getChromiumPath(),
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'networkidle0' });
      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' },
      });
      return Buffer.from(pdf);
    } finally {
      await browser.close();
    }
  }

  static async generateInvoiceDetailPDF(viewModel: PdfViewModel): Promise<Buffer> {
    const port = parseInt(process.env.PORT || '5000', 10);
    const invoiceNumber = viewModel.invoice.invoiceNumber;

    // Build the QR source list from the exact same normalized site metadata
    // consumed by the synchronous ticket builders. One Promise.all covers the
    // complete packet, so pinned rows never serialize QR generation.
    const pinQrSources: PdfPinQrSource[] = [
      ...viewModel.workOrders.map(wo => ({
        mapUrl: buildPdfWorkOrderSiteMetadata(wo).pin?.mapUrl ?? null,
        invoiceNumber,
        ticketLabel: `Work Order ${wo.workOrderNumber}`,
      })),
      ...viewModel.billingSheets.map(bs => ({
        mapUrl: buildPdfBillingSheetSiteMetadata(bs).pin?.mapUrl ?? null,
        invoiceNumber,
        ticketLabel: `Billing Sheet ${bs.billingNumber}`,
      })),
      ...viewModel.wetCheckBillings.map(wcb => ({
        mapUrl: buildPdfWetCheckSiteMetadata(wcb).pin?.mapUrl ?? null,
        invoiceNumber,
        ticketLabel: `WC Billing ${wcb.wetCheckBilling.billingNumber}`,
      })),
    ];
    const pinQrDataUris = await preloadPinQrs(pinQrSources);
    const woPinQrDataUris = pinQrDataUris.slice(0, viewModel.workOrders.length);
    const bsQrStart = viewModel.workOrders.length;
    const bsPinQrDataUris = pinQrDataUris.slice(bsQrStart, bsQrStart + viewModel.billingSheets.length);
    const wcbQrStart = bsQrStart + viewModel.billingSheets.length;
    const wcbPinQrDataUris = pinQrDataUris.slice(wcbQrStart);

    const woPhotoMaps: string[][] = [];
    for (const wo of viewModel.workOrders) {
      const result = wo.photos.length > 0 ? await preloadPhotos(wo.photos, port) : [];
      const failCount = result.filter(r => r === FAILED_PHOTO_SENTINEL).length;
      if (failCount > 0) {
        console.warn(`[PDF] Invoice ${invoiceNumber}: Work Order ${wo.workOrderNumber} — ${failCount} photo(s) failed to load`);
      }
      woPhotoMaps.push(result);
    }

    const bsPhotoMaps: string[][] = [];
    for (const bs of viewModel.billingSheets) {
      const result = bs.photos.length > 0 ? await preloadPhotos(bs.photos, port) : [];
      const failCount = result.filter(r => r === FAILED_PHOTO_SENTINEL).length;
      if (failCount > 0) {
        console.warn(`[PDF] Invoice ${invoiceNumber}: Billing Sheet ${bs.billingNumber} — ${failCount} photo(s) failed to load`);
      }
      bsPhotoMaps.push(result);
    }

    const wcbPhotoMaps: string[][] = [];
    // Task #843 — parallel resolved zone photo groups (one entry per WCB row)
    const wcbZonePhotoGroupMaps: Array<WcbZonePhotoGroupResolved[] | undefined> = [];

    for (const wcbRow of viewModel.wetCheckBillings) {
      // Prefer the merged, deduped URL list from the service layer (combines
      // wet_check_photos new-system rows with the legacy wcb.photos snapshot).
      // Fall back to the legacy array for callers that bypass InvoicePdfService.
      const photos = wcbRow.mergedPhotoUrls
        ?? (Array.isArray(wcbRow.wetCheckBilling.photos) ? wcbRow.wetCheckBilling.photos.filter(Boolean) : []);
      const result = photos.length > 0 ? await preloadPhotos(photos, port) : [];
      const failCount = result.filter(r => r === FAILED_PHOTO_SENTINEL).length;
      if (failCount > 0) {
        console.warn(`[PDF] Invoice ${invoiceNumber}: WC Billing ${wcbRow.wetCheckBilling.billingNumber} — ${failCount} photo(s) failed to load`);
      }
      wcbPhotoMaps.push(result);

      // Task #843 — resolve grouped photo URLs → data URIs
      if (Array.isArray(wcbRow.zonePhotoGroups) && wcbRow.zonePhotoGroups.length > 0) {
        const resolved = await resolveZonePhotoGroups(wcbRow.zonePhotoGroups, port, invoiceNumber, wcbRow.wetCheckBilling.billingNumber);
        wcbZonePhotoGroupMaps.push(resolved.length > 0 ? resolved : undefined);
      } else {
        wcbZonePhotoGroupMaps.push(undefined);
      }
    }

    const browser = await puppeteer.launch({
      headless: true,
      executablePath: getChromiumPath(),
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
      const page = await browser.newPage();

       const htmlContent = this.generateInvoiceDetailHTML(
         viewModel,
         woPhotoMaps,
         bsPhotoMaps,
         wcbPhotoMaps,
         viewModel.brandColors,
         wcbZonePhotoGroupMaps,
         woPinQrDataUris,
         bsPinQrDataUris,
         wcbPinQrDataUris,
       );

      await page.setContent(htmlContent, { waitUntil: 'domcontentloaded' });

      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: '<span></span>',
        footerTemplate: `
          <div style="width:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:10px;color:#9ca3af;display:flex;justify-content:space-between;align-items:center;padding:0 0.5in;box-sizing:border-box;">
            <div style="display:flex;align-items:center;gap:6px;">
              ${IRRIGOPRO_LOGO_DATA_URI ? `<img src="${IRRIGOPRO_LOGO_DATA_URI}" style="height:14px;" alt="IrrigoPro" />` : ''}
              <span style="color:#9ca3af;font-size:10px;">Powered by</span>
              ${VRT_LOGO_DATA_URI
                ? `<img src="${VRT_LOGO_DATA_URI}" style="height:16px;" alt="VRT Sync" />`
                : '<span style="color:#9ca3af;">VRT Sync</span>'}
            </div>
            <span style="color:#9ca3af;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
          </div>
        `,
        margin: {
          top: '0.5in',
          right: '0.5in',
          bottom: '0.75in',
          left: '0.5in'
        }
      });
      return Buffer.from(pdf);
    } finally {
      await browser.close();
    }
  }

  private static generateInvoiceDetailHTML(
    vm: PdfViewModel,
    woPhotoMaps: string[][] = [],
    bsPhotoMaps: string[][] = [],
    wcbPhotoMaps: string[][] = [],
    brandColors: PdfBrandColors = DEFAULT_BRAND_COLORS,
    wcbZonePhotoGroupMaps: Array<WcbZonePhotoGroupResolved[] | undefined> = [],
    woPinQrDataUris: Array<string | null> = [],
    bsPinQrDataUris: Array<string | null> = [],
    wcbPinQrDataUris: Array<string | null> = [],
  ): string {
    const { invoice, workOrders, billingSheets, wetCheckBillings } = vm;

    const ticketPages = [
      ...workOrders.map((wo, i) => ticketPageWO(wo, invoice.invoiceNumber, woPhotoMaps[i] ?? [], vm.company.logoDataUri, vm.company.name, woPinQrDataUris[i])),
      ...billingSheets.map((bs, i) => ticketPageBS(bs, invoice.invoiceNumber, bsPhotoMaps[i] ?? [], vm.company.logoDataUri, vm.company.name, brandColors, bsPinQrDataUris[i])),
      ...wetCheckBillings.map((wcb, i) => ticketPageWCB(wcb, invoice.invoiceNumber, wcbPhotoMaps[i] ?? [], vm.company.logoDataUri, vm.company.name, brandColors, wcbZonePhotoGroupMaps[i], wcbPinQrDataUris[i])),
    ].join('');

    // Task #1809 — standalone invoices skip the reconciliation summary page
    // (it adds no value for a single-ticket bill and duplicates the ticket detail).
    const reconcSection = invoice.billingType === 'standalone' ? '' : reconciliationPage(vm);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Invoice ${invoice.invoiceNumber} – Billing Document</title>
  <style>${buildFullCSS(brandColors)}</style>
</head>
<body>
  <div class="container">
    ${coverPage(vm)}
    ${reconcSection}
    ${ticketPages}
  </div>
</body>
</html>`;
  }
}
