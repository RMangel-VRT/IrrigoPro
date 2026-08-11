import sgMail from '@sendgrid/mail';
import { ObjectStorageService } from './objectStorage';
import { storage } from './storage';
import { formatEstimateNumber } from '@workspace/shared';
import { resolveCompanyLogoUrl } from './logo-url';

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const DEFAULT_FROM_EMAIL =
  process.env.SENDGRID_FROM_EMAIL ||
  process.env.FROM_EMAIL ||
  process.env.POSTMARK_FROM_EMAIL ||
  'estimates@highplainsprop.com';
const SENDGRID_FROM_NAME =
  process.env.SENDGRID_FROM_NAME || 'High Plains Irrigation Team';

if (SENDGRID_API_KEY) {
  sgMail.setApiKey(SENDGRID_API_KEY);
} else {
  console.warn(
    'SENDGRID_API_KEY not configured — transactional emails will not be sent.',
  );
}

function isEmailConfigured(): boolean {
  return Boolean(SENDGRID_API_KEY);
}

export interface EstimateEmailData {
  estimateId: number;
  estimateNumber: string;
  customerName: string;
  customerEmail: string;
  projectName: string;
  projectAddress?: string;
  workLocationLat?: string | null;
  workLocationLng?: string | null;
  workLocationAddress?: string | null;
  controllerLetter?: string | null;
  zoneNumber?: number | null;
  totalAmount: string;
  // Numeric subtotals for the breakdown block (Parts → Labor → Total).
  partsSubtotal?: number;
  laborSubtotal?: number;
  totalLaborHours?: number;
  laborRate?: number;
  // When true the email renders zone-grouped (inspection-origin estimate).
  isInspectionOrigin?: boolean;
  approvalToken: string;
  estimateDate: string;
  createdBy: string;
  companyId: number;
  workDescription?: string | null;
  items?: Array<{
    description: string;
    partName: string;
    quantity: number;
    partPrice: number;
    laborHours: number;
    partsCost: number;
    laborCost: number;
    lineTotal: number;
    // Zone fields present for inspection-origin estimates.
    controllerLetter?: string | null;
    zoneNumber?: number | null;
    issueType?: string | null;
  }>;
  // Task #616 — optional recipient overrides + manager note. When `to`
  // is omitted the email goes to `customerEmail` on file. `cc`/`bcc`
  // are forwarded straight to SendGrid. `note` renders above the
  // estimate summary in both HTML and text bodies (HTML-escaped).
  to?: string;
  cc?: string[];
  bcc?: string[];
  note?: string;
  // Task #1791 — optional PDF attachment (base64-encoded PDF buffer).
  // When present, the attachment is forwarded to SendGrid as a file
  // attachment so the customer receives the estimate as a PDF document.
  attachments?: Array<{
    content: string;
    filename: string;
    type: string;
    disposition: 'attachment';
  }>;
}

export class EmailService {
  private static get baseUrl() {
    // APP_BASE_URL must be set to the public domain in production
    // (e.g. https://irrigopro.com) so that logo <img> tags and approval-page
    // links embedded in outgoing emails are reachable by email recipients.
    // Without it, logo URLs and approval links will point to the Replit
    // preview domain, which may not be publicly accessible.
    if (process.env.APP_BASE_URL) {
      return process.env.APP_BASE_URL.replace(/\/$/, '');
    }

    if (process.env.NODE_ENV === 'production') {
      console.warn(
        '[email-service] APP_BASE_URL is not set in production — ' +
        'logo and approval-page URLs in outgoing emails may not be reachable by recipients.',
      );
      return 'https://irrigopro.com';
    }

    // Development: use the current Replit preview domain if available
    const replitDomain = process.env.REPLIT_DOMAINS?.split(',')[0];
    if (replitDomain) {
      return `https://${replitDomain}`;
    }

    return `https://${process.env.REPL_ID}.${process.env.REPL_OWNER}.replit.dev`;
  }

  static async sendEstimateApprovalEmail(data: EstimateEmailData): Promise<void> {
    // Task #703 — make a missing API key a hard failure on the
    // estimate path so the route helper's try/catch rolls back the
    // DB write and the frontend surfaces a real error instead of a
    // misleading "Sent." toast.
    if (!isEmailConfigured()) {
      throw new Error(
        'Email is not configured: SENDGRID_API_KEY is missing. Estimate was not sent.',
      );
    }

    const approveUrl = `${this.baseUrl}/estimate-approval/${data.approvalToken}`;
    // Task #1574 — reject link goes to the React portal with ?intent=reject so
    // email security scanners (MS Safe Links, Google) only fetch a React page,
    // not the API endpoint that previously committed the rejection immediately.
    const rejectUrl = `${this.baseUrl}/estimate-approval/${data.approvalToken}?intent=reject`;
    const viewUrl = `${this.baseUrl}/estimate-approval/${data.approvalToken}`;

    // Get company information including logo
    const company = await storage.getCompanyProfile(data.companyId);
    const resolvedLogoUrl = company?.logo ? this.getCompanyLogoUrl(company.logo) : null;
    console.log(`[estimate-email] send est=${data.estimateNumber} logo=${resolvedLogoUrl ?? '(none)'} baseUrl=${this.baseUrl}`);
    const companyInfo = {
      name: company?.name || 'IrrigoPro',
      logo: resolvedLogoUrl,
      email: company?.email || DEFAULT_FROM_EMAIL,
      phone: company?.phone || '',
      website: company?.website || ''
    };

    const htmlContent = this.generateEstimateEmailHTML(data, approveUrl, rejectUrl, viewUrl, companyInfo);
    const textContent = this.generateEstimateEmailText(data, approveUrl, rejectUrl, companyInfo);

    const toAddr = (data.to && data.to.trim()) || data.customerEmail;
    const ccList = (data.cc ?? []).filter((s) => s && s.trim().length > 0);
    const bccList = (data.bcc ?? []).filter((s) => s && s.trim().length > 0);

    // Task #703 — SendGrid rejects any send whose `from` is not a
    // verified sender identity. Use the verified DEFAULT_FROM_EMAIL
    // as the envelope From and set the company's profile email as
    // Reply-To so customer replies still route to the company
    // (mirrors `sendMarketingLeadNotification`).
    const replyToAddr =
      companyInfo.email && companyInfo.email.trim().length > 0
        ? companyInfo.email
        : undefined;

    try {
      await sgMail.send({
        from: { email: DEFAULT_FROM_EMAIL, name: SENDGRID_FROM_NAME },
        ...(replyToAddr ? { replyTo: replyToAddr } : {}),
        to: toAddr,
        ...(ccList.length ? { cc: ccList } : {}),
        ...(bccList.length ? { bcc: bccList } : {}),
        subject: `Irrigation Estimate #${String(data.estimateNumber).replace(/^EST-?/i, '')}`,
        html: htmlContent,
        text: textContent,
        categories: ['estimate-approval'],
        customArgs: {
          estimateId: data.estimateId.toString(),
          estimateNumber: data.estimateNumber,
          companyId: data.companyId.toString()
        },
        // Task #1791 — forward PDF attachment when the caller provides one.
        ...(data.attachments && data.attachments.length > 0
          ? { attachments: data.attachments }
          : {}),
      });

      console.log(`Estimate approval email sent to ${toAddr}${ccList.length ? ` (cc ${ccList.join(', ')})` : ''}${bccList.length ? ` (bcc ${bccList.join(', ')})` : ''}`);
    } catch (error: any) {
      // Task #703 — SendGrid puts the actionable reason on
      // error.response.body.errors[*].message (e.g. "The from
      // address does not match a verified Sender Identity"). Log
      // the structured payload and re-throw an Error whose message
      // includes that reason so the route handler returns it in
      // the JSON response and the frontend toast is actionable.
      const sgErrors = error?.response?.body?.errors;
      const sgReason = Array.isArray(sgErrors)
        ? sgErrors
            .map((e: any) => e?.message)
            .filter((m: unknown): m is string => typeof m === 'string' && m.length > 0)
            .join('; ')
        : '';
      console.error('Failed to send estimate approval email:', {
        statusCode: error?.code ?? error?.response?.statusCode,
        body: error?.response?.body,
        message: error?.message,
      });
      const baseMsg =
        (error instanceof Error && error.message) || 'Unknown SendGrid error';
      throw new Error(
        sgReason
          ? `SendGrid rejected the estimate email: ${sgReason}`
          : `Failed to send estimate email: ${baseMsg}`,
      );
    }
  }

  private static escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private static getCompanyLogoUrl(logoPath: string): string | null {
    return resolveCompanyLogoUrl(logoPath, this.baseUrl);
  }

  // ── Zone-grouping for inspection-origin estimates ─────────────────────────

  private static buildEmailZoneGroups(
    items: NonNullable<EstimateEmailData['items']>,
    laborRate: number,
  ) {
    type EmailZoneGroup = {
      controllerLetter: string;
      zoneNumber: number;
      zoneLabel: string;
      items: NonNullable<EstimateEmailData['items']>;
      partsTotal: number;
      laborHrs: number;
      laborAmt: number;
      zoneTotal: number;
    };
    const groupMap = new Map<string, EmailZoneGroup>();
    for (const item of items) {
      const cl = item.controllerLetter ?? '';
      const zn = item.zoneNumber ?? 0;
      const key = `${cl}|${zn}`;
      let group = groupMap.get(key);
      if (!group) {
        const zoneLabel =
          cl && zn
            ? `Controller ${cl} \u00b7 Zone ${zn}`
            : cl
            ? `Controller ${cl}`
            : `Zone ${zn}`;
        group = {
          controllerLetter: cl,
          zoneNumber: zn,
          zoneLabel,
          items: [],
          partsTotal: 0,
          laborHrs: 0,
          laborAmt: 0,
          zoneTotal: 0,
        };
        groupMap.set(key, group);
      }
      group.items.push(item);
      group.partsTotal += item.partsCost;
      group.laborHrs += item.laborHours;
    }
    for (const g of groupMap.values()) {
      g.laborAmt = g.laborHrs * laborRate;
      g.zoneTotal = g.partsTotal + g.laborAmt;
    }
    return [...groupMap.values()].sort((a, b) => {
      const cl = a.controllerLetter.localeCompare(b.controllerLetter);
      if (cl !== 0) return cl;
      return a.zoneNumber - b.zoneNumber;
    });
  }

  private static fmt(n: number): string {
    return `$${n.toFixed(2)}`;
  }

  private static renderEmailTotalsBlock(
    partsSubtotal: number,
    laborSubtotal: number,
    totalLaborHours: number,
    laborRate: number,
    grandTotal: string,
  ): string {
    const laborLabel = `Labor (${totalLaborHours.toFixed(2)}h \u00d7 ${this.fmt(laborRate)}/hr)`;
    return `
      <table role="presentation" style="width: 100%; max-width: 320px; margin: 16px 0 0 auto; border-collapse: collapse; font-size: 14px;">
        <tr>
          <td style="padding: 5px 8px; color: #6b7280;">Parts Subtotal</td>
          <td style="padding: 5px 8px; text-align: right; color: #1f2937;">${this.fmt(partsSubtotal)}</td>
        </tr>
        <tr>
          <td style="padding: 5px 8px; color: #6b7280;">${this.escapeHtml(laborLabel)}</td>
          <td style="padding: 5px 8px; text-align: right; color: #1f2937;">${this.fmt(laborSubtotal)}</td>
        </tr>
        <tr style="border-top: 2px solid #1E5A99;">
          <td style="padding: 8px 8px; font-weight: 700; color: #1f2937; font-size: 15px;">Total</td>
          <td style="padding: 8px 8px; text-align: right; font-weight: 700; color: #1E5A99; font-size: 18px;">${this.escapeHtml(grandTotal)}</td>
        </tr>
      </table>`;
  }

  private static renderZoneGroupedEmailHTML(
    data: EstimateEmailData,
  ): string {
    const items = data.items ?? [];
    const laborRate = data.laborRate ?? 0;
    const groups = this.buildEmailZoneGroups(items, laborRate);
    const th = (label: string, align: string = 'left') =>
      `<th style="padding: 7px 9px; text-align: ${align}; background: #143F6B; color: white; font-size: 12px; font-weight: 600;">${label}</th>`;
    const tdStyle = (extra = '') =>
      `padding: 7px 9px; border-bottom: 1px solid #e5e7eb; font-size: 13px; vertical-align: top; ${extra}`;

    const summaryRows = groups
      .map(
        (g, idx) => `
        <tr style="${idx % 2 === 1 ? 'background: #f9fafb;' : ''}">
          <td style="${tdStyle('font-weight: 600;')}">${this.escapeHtml(g.zoneLabel)}</td>
          <td style="${tdStyle('text-align: right;')}">${g.items.length}</td>
          <td style="${tdStyle('text-align: right;')}">${this.fmt(g.partsTotal)}</td>
          <td style="${tdStyle('text-align: right;')}">${g.laborHrs.toFixed(2)}h</td>
          <td style="${tdStyle('text-align: right; font-weight: 600;')}">${this.fmt(g.zoneTotal)}</td>
        </tr>`,
      )
      .join('');
    const summaryTotals = `
        <tr style="background: #f0f6ff; border-top: 2px solid #1E5A99;">
          <td style="${tdStyle('font-weight: 700;')}">Totals</td>
          <td style="${tdStyle('text-align: right; font-weight: 700;')}">${groups.reduce((s, g) => s + g.items.length, 0)}</td>
          <td style="${tdStyle('text-align: right; font-weight: 700;')}">${this.fmt(groups.reduce((s, g) => s + g.partsTotal, 0))}</td>
          <td style="${tdStyle('text-align: right; font-weight: 700;')}">${groups.reduce((s, g) => s + g.laborHrs, 0).toFixed(2)}h</td>
          <td style="${tdStyle('text-align: right; font-weight: 700;')}">${this.fmt(groups.reduce((s, g) => s + g.zoneTotal, 0))}</td>
        </tr>`;

    const summaryTable = `
      <h3 style="color: #374151; margin: 0 0 10px 0; font-size: 15px;">Repairs Summary by Zone</h3>
      <table role="presentation" style="width: 100%; border-collapse: collapse; border: 1px solid #dce8f7; font-size: 13px; margin-bottom: 20px;">
        <thead><tr>${th('Zone')}${th('Repairs', 'right')}${th('Parts', 'right')}${th('Labor hrs', 'right')}${th('Zone Total', 'right')}</tr></thead>
        <tbody>${summaryRows}${summaryTotals}</tbody>
      </table>`;

    const zoneBlocks = groups
      .map((g) => {
        const workRows = g.items
          .map((item, idx) => {
            const issueLabel = item.issueType
              ? item.issueType.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
              : item.description || item.partName;
            return `
          <tr style="${idx % 2 === 1 ? 'background: #f9fafb;' : ''}">
            <td style="${tdStyle('')}">${this.escapeHtml(issueLabel)}</td>
            <td style="${tdStyle('text-align: right;')}">${item.quantity}</td>
            <td style="${tdStyle('text-align: right;')}">${this.fmt(item.partPrice)}</td>
            <td style="${tdStyle('text-align: right;')}">${this.fmt(item.partsCost)}</td>
          </tr>`;
          })
          .join('');
        const laborRow = `
          <tr style="background: #f8fafc;">
            <td colspan="3" style="${tdStyle('color: #6b7280; font-style: italic;')}">Zone labor &middot; ${g.laborHrs.toFixed(2)}h &times; ${this.fmt(laborRate)}/hr</td>
            <td style="${tdStyle('text-align: right; font-style: italic; color: #6b7280;')}">${this.fmt(g.laborAmt)}</td>
          </tr>`;
        const subtotalRow = `
          <tr style="background: #f0f6ff; border-top: 2px solid #1E5A99;">
            <td colspan="3" style="${tdStyle('font-weight: 700;')}">${this.escapeHtml(g.zoneLabel)} Subtotal</td>
            <td style="${tdStyle('text-align: right; font-weight: 700; color: #143F6B;')}">${this.fmt(g.zoneTotal)}</td>
          </tr>`;
        return `
        <div style="margin-bottom: 16px; border: 1px solid #dce8f7; border-radius: 6px; overflow: hidden;">
          <div style="background: #1E5A99; color: white; padding: 8px 12px; display: flex; justify-content: space-between;">
            <span style="font-weight: 700; font-size: 13px;">${this.escapeHtml(g.zoneLabel)}</span>
            <span style="font-weight: 700; font-size: 13px;">${this.fmt(g.zoneTotal)}</span>
          </div>
          <table role="presentation" style="width: 100%; border-collapse: collapse; font-size: 13px;">
            <thead><tr style="background: #143F6B;">
              ${th('Work / Finding')}${th('Qty', 'right')}${th('Unit Price', 'right')}${th('Parts Total', 'right')}
            </tr></thead>
            <tbody>${workRows}${laborRow}${subtotalRow}</tbody>
          </table>
        </div>`;
      })
      .join('');

    return `
      <div style="margin: 20px 0;">
        <h3 style="color: #374151; margin-bottom: 16px;">Zone Detail</h3>
        ${summaryTable}
        ${zoneBlocks}
      </div>`;
  }

  private static renderFlatEmailItemsHTML(
    data: EstimateEmailData,
  ): string {
    if (!data.items?.length) return '';
    const itemsRowsHTML = data.items
      .map(
        (item) => `
        <tr>
          <td style="padding: 10px 12px; border-bottom: 1px solid #e5e7eb; vertical-align: top; color: #1f2937;">${this.escapeHtml(item.description || item.partName)}</td>
          <td style="padding: 10px 12px; border-bottom: 1px solid #e5e7eb; text-align: right; color: #1f2937; white-space: nowrap;">${item.quantity}</td>
          <td style="padding: 10px 12px; border-bottom: 1px solid #e5e7eb; text-align: right; color: #1f2937; white-space: nowrap;">${this.fmt(item.partPrice)}</td>
          <td style="padding: 10px 12px; border-bottom: 1px solid #e5e7eb; text-align: right; color: #1f2937; white-space: nowrap;">${this.fmt(item.laborCost)} (${item.laborHours.toFixed(2)}h)</td>
          <td style="padding: 10px 12px; border-bottom: 1px solid #e5e7eb; text-align: right; color: #1f2937; white-space: nowrap; font-weight: 600;">${this.fmt(item.lineTotal)}</td>
        </tr>`,
      )
      .join('');
    return `
      <div style="margin: 20px 0;">
        <h3 style="color: #374151; margin-bottom: 16px;">Line Items</h3>
        <table role="presentation" style="width: 100%; border-collapse: collapse; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; font-size: 14px;">
          <thead>
            <tr style="background: #f3f4f6;">
              <th style="padding: 10px 12px; text-align: left; color: #374151; font-weight: 600;">Description</th>
              <th style="padding: 10px 12px; text-align: right; color: #374151; font-weight: 600;">Qty</th>
              <th style="padding: 10px 12px; text-align: right; color: #374151; font-weight: 600;">Unit</th>
              <th style="padding: 10px 12px; text-align: right; color: #374151; font-weight: 600;">Labor</th>
              <th style="padding: 10px 12px; text-align: right; color: #374151; font-weight: 600;">Line Total</th>
            </tr>
          </thead>
          <tbody>${itemsRowsHTML}</tbody>
        </table>
      </div>`;
  }

  private static generateEstimateEmailHTML(
    data: EstimateEmailData, 
    approveUrl: string, 
    rejectUrl: string, 
    viewUrl: string,
    companyInfo: {
      name: string;
      logo: string | null;
      email: string;
      phone: string;
      website: string;
    }
  ): string {
    const partsSubtotal = data.partsSubtotal ?? 0;
    const laborSubtotal = data.laborSubtotal ?? 0;
    const totalLaborHours = data.totalLaborHours ?? 0;
    const laborRate = data.laborRate ?? 0;
    const hasBreakdown = partsSubtotal > 0 || laborSubtotal > 0;

    const lineItemsSection = data.isInspectionOrigin
      ? this.renderZoneGroupedEmailHTML(data)
      : this.renderFlatEmailItemsHTML(data);

    const totalsBlock = hasBreakdown
      ? this.renderEmailTotalsBlock(partsSubtotal, laborSubtotal, totalLaborHours, laborRate, data.totalAmount)
      : `
      <div style="background: #1f2937; color: white; border-radius: 8px; padding: 20px; margin: 20px 0; text-align: center;">
        <h3 style="margin: 0; font-size: 24px;">Total Estimate</h3>
        <p style="margin: 8px 0 0 0; font-size: 32px; font-weight: bold;">${this.escapeHtml(data.totalAmount)}</p>
      </div>`;

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Estimate Approval Required</title>
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #1E5A99, #0E3B6B); color: white; padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
    ${companyInfo.logo ? `
    <div style="margin-bottom: 20px;">
      <img src="${companyInfo.logo}" alt="${this.escapeHtml(companyInfo.name)} Logo" style="max-height: 60px; max-width: 200px; object-fit: contain;">
    </div>
    ` : ''}
    <h1 style="margin: 0; font-size: 28px;">Irrigation Estimate</h1>
    <p style="margin: 8px 0 0 0; font-size: 18px; opacity: 0.9;">Your Approval Required</p>
  </div>
  
  <div style="background: white; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px; padding: 30px;">
    <h2 style="color: #1f2937; margin-top: 0;">Hello ${this.escapeHtml(data.customerName)},</h2>
    
    <p style="font-size: 16px; color: #4b5563;">
      We've prepared an estimate for your irrigation project. Please review the details below and let us know if you'd like to proceed.
    </p>

    ${data.note && data.note.trim() ? `
    <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 16px 20px; margin: 20px 0; color: #92400e; font-size: 14px; line-height: 1.5; white-space: pre-wrap;">${this.escapeHtml(data.note)}</div>
    ` : ''}

    <div style="background: #f9fafb; border-radius: 8px; padding: 20px; margin: 20px 0;">
      <h3 style="margin: 0 0 16px 0; color: #374151;">Estimate Details</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 8px 0; font-weight: 600; color: #6b7280;">Estimate #:</td>
          <td style="padding: 8px 0; color: #1f2937;">${formatEstimateNumber(data.estimateNumber)}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; font-weight: 600; color: #6b7280;">Project:</td>
          <td style="padding: 8px 0; color: #1f2937;">${this.escapeHtml(data.projectName)}</td>
        </tr>
        ${data.projectAddress ? `
        <tr>
          <td style="padding: 8px 0; font-weight: 600; color: #6b7280;">Location:</td>
          <td style="padding: 8px 0; color: #1f2937;">${this.escapeHtml(data.projectAddress)}</td>
        </tr>
        ` : ''}
        ${data.workLocationLat && data.workLocationLng ? `
        <tr>
          <td style="padding: 8px 0; font-weight: 600; color: #6b7280;">Pinned spot:</td>
          <td style="padding: 8px 0; color: #1f2937;">
            ${data.workLocationAddress ? `${this.escapeHtml(data.workLocationAddress)}<br/>` : ''}
            <a href="https://www.google.com/maps/search/?api=1&query=${data.workLocationLat},${data.workLocationLng}" style="color: #1E5A99;">View on map</a>
            <span style="color: #6b7280; font-size: 12px;">(${parseFloat(String(data.workLocationLat)).toFixed(6)}, ${parseFloat(String(data.workLocationLng)).toFixed(6)})</span>
          </td>
        </tr>
        ` : ''}
        ${data.controllerLetter || data.zoneNumber ? `
        <tr>
          <td style="padding: 8px 0; font-weight: 600; color: #6b7280;">Controller / Zone:</td>
          <td style="padding: 8px 0; color: #1f2937;">${data.controllerLetter ? `Controller ${this.escapeHtml(data.controllerLetter)}` : ''}${data.controllerLetter && data.zoneNumber ? ' · ' : ''}${data.zoneNumber ? `Zone ${data.zoneNumber}` : ''}</td>
        </tr>
        ` : ''}
        <tr>
          <td style="padding: 8px 0; font-weight: 600; color: #6b7280;">Date:</td>
          <td style="padding: 8px 0; color: #1f2937;">${this.escapeHtml(data.estimateDate)}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; font-weight: 600; color: #6b7280;">Prepared by:</td>
          <td style="padding: 8px 0; color: #1f2937;">${this.escapeHtml(data.createdBy)}</td>
        </tr>
      </table>
    </div>

    ${data.workDescription ? `
    <div style="margin: 20px 0;">
      <h3 style="color: #374151; margin-bottom: 16px;">Work Description</h3>
      <div style="background: #f9fafb; border-radius: 8px; padding: 16px 20px; color: #1f2937; white-space: pre-wrap; font-size: 14px; line-height: 1.5;">${this.escapeHtml(data.workDescription)}</div>
    </div>
    ` : ''}

    ${lineItemsSection}

    <div style="margin: 20px 0; border-top: 1px solid #e5e7eb; padding-top: 16px;">
      ${totalsBlock}
    </div>

    <div style="text-align: center; margin: 30px 0;">
      <p style="font-size: 18px; color: #374151; margin-bottom: 20px;">Ready to proceed?</p>
      
      <a href="${approveUrl}" style="display: inline-block; background: #10b981; color: white; padding: 12px 30px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; margin: 0 10px 10px 10px;">
        ✓ Approve Estimate
      </a>
      
      <a href="${rejectUrl}" style="display: inline-block; background: #ef4444; color: white; padding: 12px 30px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; margin: 0 10px 10px 10px;">
        ✗ Decline Estimate
      </a>
    </div>

    <div style="border-top: 1px solid #e5e7eb; padding-top: 20px; margin-top: 30px; text-align: center;">
      <p style="color: #6b7280; font-size: 14px; margin: 0;">
        Need to review the full details? <a href="${viewUrl}" style="color: #1E5A99;">View Complete Estimate</a>
      </p>
      <div style="margin: 20px 0; color: #6b7280; font-size: 14px;">
        <p style="margin: 4px 0; font-weight: 600; color: #374151;">${this.escapeHtml(companyInfo.name)}</p>
        ${companyInfo.phone ? `<p style="margin: 4px 0;">📞 ${this.escapeHtml(companyInfo.phone)}</p>` : ''}
        ${companyInfo.email ? `<p style="margin: 4px 0;">✉️ ${this.escapeHtml(companyInfo.email)}</p>` : ''}
        ${companyInfo.website ? `<p style="margin: 4px 0;">🌐 <a href="${companyInfo.website}" style="color: #1E5A99;">${this.escapeHtml(companyInfo.website)}</a></p>` : ''}
      </div>
      <p style="color: #6b7280; font-size: 12px; margin: 8px 0 0 0;">
        Questions? Reply to this email or call us directly.
      </p>
    </div>
  </div>
</body>
</html>
    `;
  }

  private static generateEstimateEmailText(
    data: EstimateEmailData, 
    approveUrl: string, 
    rejectUrl: string,
    companyInfo: {
      name: string;
      logo: string | null;
      email: string;
      phone: string;
      website: string;
    }
  ): string {
    const partsSubtotal = data.partsSubtotal ?? 0;
    const laborSubtotal = data.laborSubtotal ?? 0;
    const totalLaborHours = data.totalLaborHours ?? 0;
    const laborRate = data.laborRate ?? 0;
    const hasBreakdown = partsSubtotal > 0 || laborSubtotal > 0;

    const itemsText = data.isInspectionOrigin
      ? (() => {
          const groups = this.buildEmailZoneGroups(data.items ?? [], laborRate);
          return groups
            .map((g) => {
              const zoneItems = g.items
                .map((item) => `  ${item.description || item.partName}: ${item.quantity} × ${this.fmt(item.partPrice)} = ${this.fmt(item.partsCost)}`)
                .join('\n');
              return `${g.zoneLabel}\n${zoneItems}\n  Zone labor: ${g.laborHrs.toFixed(2)}h × ${this.fmt(laborRate)}/hr = ${this.fmt(g.laborAmt)}\n  Zone Subtotal: ${this.fmt(g.zoneTotal)}`;
            })
            .join('\n\n');
        })()
      : data.items
          ?.map(
            (item) =>
              `${item.description || item.partName}: ${item.quantity} × ${this.fmt(item.partPrice)} + Labor ${item.laborHours.toFixed(2)}h (${this.fmt(item.laborCost)}) = ${this.fmt(item.lineTotal)}`,
          )
          .join('\n') ?? '';

    const breakdownText = hasBreakdown
      ? `
PRICE BREAKDOWN:
  Parts Subtotal: ${this.fmt(partsSubtotal)}
  Labor (${totalLaborHours.toFixed(2)}h × ${this.fmt(laborRate)}/hr): ${this.fmt(laborSubtotal)}
  ─────────────────────────
  Total: ${data.totalAmount}`
      : `
TOTAL ESTIMATE: ${data.totalAmount}`;

    return `
IRRIGATION ESTIMATE - APPROVAL REQUIRED

Hello ${data.customerName},

We've prepared an estimate for your irrigation project. Please review the details below:
${data.note && data.note.trim() ? `
NOTE FROM ${companyInfo.name.toUpperCase()}:
${data.note}
` : ''}
ESTIMATE DETAILS:
- Estimate: ${formatEstimateNumber(data.estimateNumber)}
- Project: ${data.projectName}
${data.projectAddress ? `- Location: ${data.projectAddress}` : ''}
${data.workLocationLat && data.workLocationLng ? `- Pinned spot: ${data.workLocationAddress ? `${data.workLocationAddress} ` : ''}(${parseFloat(String(data.workLocationLat)).toFixed(6)}, ${parseFloat(String(data.workLocationLng)).toFixed(6)}) — https://www.google.com/maps/search/?api=1&query=${data.workLocationLat},${data.workLocationLng}` : ''}
${data.controllerLetter || data.zoneNumber ? `- Controller/Zone: ${data.controllerLetter ? `Controller ${data.controllerLetter}` : ''}${data.controllerLetter && data.zoneNumber ? ' · ' : ''}${data.zoneNumber ? `Zone ${data.zoneNumber}` : ''}` : ''}
- Date: ${data.estimateDate}
- Prepared by: ${data.createdBy}

${data.workDescription ? `
WORK DESCRIPTION:
${data.workDescription}
` : ''}
${itemsText ? `
${data.isInspectionOrigin ? 'ZONE DETAIL:' : 'LINE ITEMS:'}
${itemsText}
` : ''}
${breakdownText}

ACTIONS:
- To approve this estimate, visit: ${approveUrl}
- To decline this estimate, visit: ${rejectUrl}
- To view the full estimate, visit: ${approveUrl}

---
${companyInfo.name}
${companyInfo.phone ? `Phone: ${companyInfo.phone}` : ''}
${companyInfo.email ? `Email: ${companyInfo.email}` : ''}
${companyInfo.website ? `Website: ${companyInfo.website}` : ''}

Questions? Reply to this email or call us directly.
    `;
  }

  static async sendMarketingLeadNotification(data: {
    companyName: string;
    contactName: string;
    email: string;
    phone?: string | null;
    numTechnicians?: number | null;
    message?: string | null;
  }): Promise<void> {
    if (!isEmailConfigured()) {
      console.error('SENDGRID_API_KEY not configured — marketing lead email skipped');
      return;
    }
    const toAddr =
      process.env.MARKETING_LEAD_TO_EMAIL ||
      process.env.LEADS_NOTIFY_EMAIL ||
      process.env.FROM_EMAIL;
    const fromAddr =
      process.env.MARKETING_LEAD_FROM_EMAIL ||
      DEFAULT_FROM_EMAIL;
    if (!toAddr) {
      console.error(
        'No recipient address for marketing lead email (set MARKETING_LEAD_TO_EMAIL, LEADS_NOTIFY_EMAIL, or FROM_EMAIL)',
      );
      return;
    }

    const lines = [
      `Company:      ${data.companyName}`,
      `Contact:      ${data.contactName}`,
      `Email:        ${data.email}`,
      `Phone:        ${data.phone || '(not provided)'}`,
      `Technicians:  ${data.numTechnicians ?? '(not provided)'}`,
      ``,
      `Message:`,
      data.message || '(none)',
    ];
    const esc = (v: string | number | null | undefined): string => {
      if (v === null || v === undefined || v === '') return '(not provided)';
      return String(v).replace(/[&<>"']/g, (c) =>
        c === '&' ? '&amp;' :
        c === '<' ? '&lt;' :
        c === '>' ? '&gt;' :
        c === '"' ? '&quot;' : '&#39;',
      );
    };
    const escEmail = encodeURIComponent(data.email);
    const htmlBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: linear-gradient(135deg, #1E5A99, #7DBE3F); color: white; padding: 24px; border-radius: 12px 12px 0 0;">
          <h1 style="margin: 0; font-size: 22px;">New IrrigoPro demo request</h1>
          <p style="margin: 6px 0 0 0; opacity: 0.9;">From the marketing site</p>
        </div>
        <div style="background: white; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px; padding: 24px;">
          <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
            <tr><td style="padding: 6px 0; font-weight: 600; color: #6b7280; width: 130px;">Company</td><td style="padding: 6px 0;">${esc(data.companyName)}</td></tr>
            <tr><td style="padding: 6px 0; font-weight: 600; color: #6b7280;">Contact</td><td style="padding: 6px 0;">${esc(data.contactName)}</td></tr>
            <tr><td style="padding: 6px 0; font-weight: 600; color: #6b7280;">Email</td><td style="padding: 6px 0;"><a href="mailto:${escEmail}" style="color:#1E5A99;">${esc(data.email)}</a></td></tr>
            <tr><td style="padding: 6px 0; font-weight: 600; color: #6b7280;">Phone</td><td style="padding: 6px 0;">${esc(data.phone)}</td></tr>
            <tr><td style="padding: 6px 0; font-weight: 600; color: #6b7280;">Technicians</td><td style="padding: 6px 0;">${esc(data.numTechnicians)}</td></tr>
          </table>
          <h3 style="margin-top: 20px; color: #1f2937;">Message</h3>
          <div style="white-space: pre-wrap; background: #f9fafb; border-radius: 8px; padding: 12px; color: #374151; font-size: 14px;">${data.message ? esc(data.message) : '(none)'}</div>
        </div>
      </div>`;

    try {
      await sgMail.send({
        from: fromAddr,
        to: toAddr,
        replyTo: data.email,
        subject: `New IrrigoPro demo request — ${data.companyName}`,
        html: htmlBody,
        text: lines.join('\n'),
        categories: ['marketing-lead'],
      });
      console.log(`Marketing lead notification sent to ${toAddr}`);
    } catch (error) {
      console.error('Failed to send marketing lead notification:', error);
    }
  }

  static async sendApprovalConfirmation(customerEmail: string, estimateNumber: string, approved: boolean): Promise<void> {
    if (!isEmailConfigured()) {
      console.error('SENDGRID_API_KEY not configured');
      return;
    }

    const action = approved ? 'approved' : 'declined';
    const nextSteps = approved 
      ? 'We will begin scheduling your irrigation work and will contact you soon with next steps.'
      : 'Thank you for your time. Please feel free to contact us if you have any questions or would like to discuss alternatives.';

    try {
      await sgMail.send({
        from: DEFAULT_FROM_EMAIL,
        to: customerEmail,
        subject: `Estimate ${approved ? 'Approved' : 'Declined'} - ${formatEstimateNumber(estimateNumber)}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <h2 style="color: ${approved ? '#10b981' : '#6b7280'};">
              Estimate ${approved ? 'Approved' : 'Declined'}
            </h2>
            <p>Thank you for your response regarding estimate ${formatEstimateNumber(estimateNumber)}.</p>
            <p>We have recorded that you have <strong>${action}</strong> this estimate.</p>
            <p>${nextSteps}</p>
            <p>If you have any questions, please don't hesitate to contact us.</p>
            <p>Best regards,<br>Your Irrigation Team</p>
          </div>
        `,
        text: `
Estimate ${approved ? 'Approved' : 'Declined'} - ${formatEstimateNumber(estimateNumber)}

Thank you for your response regarding estimate ${formatEstimateNumber(estimateNumber)}.

We have recorded that you have ${action} this estimate.

${nextSteps}

If you have any questions, please don't hesitate to contact us.

Best regards,
Your Irrigation Team
        `,
        categories: ['estimate-confirmation'],
      });

      console.log(`Approval confirmation sent to ${customerEmail}`);
    } catch (error) {
      console.error('Failed to send approval confirmation:', error);
      throw error;
    }
  }

  // Email verification functionality
  static async sendEmailVerification(email: string, verificationToken: string, userName: string): Promise<void> {
    if (!isEmailConfigured()) {
      console.error('SENDGRID_API_KEY not configured');
      return;
    }

    const verifyUrl = `${this.baseUrl}/api/auth/verify-email/${verificationToken}`;

    try {
      await sgMail.send({
        from: DEFAULT_FROM_EMAIL,
        to: email,
        subject: 'Verify Your IrrigoPro Account',
        html: `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Verify Your Account</title>
          </head>
          <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="background: linear-gradient(135deg, #1E5A99, #0E3B6B); color: white; padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
              <h1 style="margin: 0; font-size: 28px;">Welcome to IrrigoPro</h1>
              <p style="margin: 8px 0 0 0; font-size: 18px; opacity: 0.9;">Verify Your Account</p>
            </div>
            
            <div style="background: white; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px; padding: 30px;">
              <h2 style="color: #1f2937; margin-top: 0;">Hello ${userName},</h2>
              
              <p style="font-size: 16px; color: #4b5563;">
                Thank you for creating your IrrigoPro account! To complete your registration and ensure account security, please verify your email address by clicking the button below.
              </p>
              
              <div style="text-align: center; margin: 30px 0;">
                <a href="${verifyUrl}" style="display: inline-block; background: #10b981; color: white; padding: 15px 40px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 18px;">
                  Verify Email Address
                </a>
              </div>

              <div style="background: #f9fafb; border-radius: 8px; padding: 20px; margin: 20px 0;">
                <p style="margin: 0; color: #6b7280; font-size: 14px;">
                  <strong>Security Notice:</strong> This verification link will expire in 24 hours for your security. If you didn't create this account, please ignore this email.
                </p>
              </div>

              <div style="border-top: 1px solid #e5e7eb; padding-top: 20px; margin-top: 30px; text-align: center;">
                <p style="color: #6b7280; font-size: 14px; margin: 0;">
                  If the button doesn't work, copy and paste this link into your browser:
                </p>
                <p style="color: #1E5A99; font-size: 12px; word-break: break-all; margin: 8px 0;">
                  ${verifyUrl}
                </p>
              </div>
            </div>
          </body>
          </html>
        `,
        text: `
Welcome to IrrigoPro - Verify Your Account

Hello ${userName},

Thank you for creating your IrrigoPro account! To complete your registration and ensure account security, please verify your email address.

Click this link to verify: ${verifyUrl}

This verification link will expire in 24 hours for your security.

If you didn't create this account, please ignore this email.

Best regards,
The IrrigoPro Team
        `,
        categories: ['email-verification'],
      });

      console.log(`Email verification sent to ${email}`);
    } catch (error) {
      console.error('Failed to send verification email:', error);
      throw error;
    }
  }

  // Password reset functionality
  static async sendPasswordReset(email: string, resetToken: string, userName: string): Promise<void> {
    if (!isEmailConfigured()) {
      console.error('SENDGRID_API_KEY not configured');
      return;
    }

    const resetUrl = `${this.baseUrl}/reset-password?token=${resetToken}`;

    try {
      await sgMail.send({
        from: DEFAULT_FROM_EMAIL,
        to: email,
        subject: 'Reset Your IrrigoPro Password',
        html: `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Reset Your Password</title>
          </head>
          <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="background: linear-gradient(135deg, #ef4444, #dc2626); color: white; padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
              <h1 style="margin: 0; font-size: 28px;">Password Reset</h1>
              <p style="margin: 8px 0 0 0; font-size: 18px; opacity: 0.9;">IrrigoPro Account Security</p>
            </div>
            
            <div style="background: white; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px; padding: 30px;">
              <h2 style="color: #1f2937; margin-top: 0;">Hello ${userName},</h2>
              
              <p style="font-size: 16px; color: #4b5563;">
                We received a request to reset your IrrigoPro account password. If you made this request, click the button below to set a new password.
              </p>
              
              <div style="text-align: center; margin: 30px 0;">
                <a href="${resetUrl}" style="display: inline-block; background: #ef4444; color: white; padding: 15px 40px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 18px;">
                  Reset Password
                </a>
              </div>

              <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 20px; margin: 20px 0;">
                <p style="margin: 0; color: #7f1d1d; font-size: 14px;">
                  <strong>Security Notice:</strong> This reset link will expire in 1 hour. If you didn't request this password reset, please ignore this email - your password will remain unchanged.
                </p>
              </div>

              <div style="border-top: 1px solid #e5e7eb; padding-top: 20px; margin-top: 30px; text-align: center;">
                <p style="color: #6b7280; font-size: 14px; margin: 0;">
                  If the button doesn't work, copy and paste this link into your browser:
                </p>
                <p style="color: #1E5A99; font-size: 12px; word-break: break-all; margin: 8px 0;">
                  ${resetUrl}
                </p>
                <p style="color: #6b7280; font-size: 12px; margin-top: 16px;">
                  For security reasons, we recommend using a strong, unique password.
                </p>
              </div>
            </div>
          </body>
          </html>
        `,
        text: `
Reset Your IrrigoPro Password

Hello ${userName},

We received a request to reset your IrrigoPro account password. If you made this request, use the link below to set a new password:

${resetUrl}

This reset link will expire in 1 hour for your security.

If you didn't request this password reset, please ignore this email - your password will remain unchanged.

For security reasons, we recommend using a strong, unique password.

Best regards,
The IrrigoPro Team
        `,
        categories: ['password-reset'],
      });

      console.log(`Password reset email sent to ${email}`);
    } catch (error) {
      console.error('Failed to send password reset email:', error);
      throw error;
    }
  }

  static async sendMissingPhotosTechnicianEmail(args: {
    to: string;
    technicianName: string;
    sheets: Array<{
      id: number;
      billingNumber: string;
      customerName: string;
      branchName?: string | null;
      propertyAddress?: string | null;
      workDate?: Date | string | null;
    }>;
    companyName?: string;
  }): Promise<{ success: boolean; error?: string }> {
    if (!isEmailConfigured()) {
      console.error('SENDGRID_API_KEY not configured');
      return { success: false, error: 'Email service not configured' };
    }

    const baseUrl = this.baseUrl;
    const companyName = args.companyName || 'IrrigoPro';
    const fmtDate = (d?: Date | string | null) =>
      d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';

    const rowsHtml = args.sheets.map(s => {
      const url = `${baseUrl}/billing-sheets?openSheet=${s.id}`;
      const where = [s.customerName, s.branchName, s.propertyAddress].filter(Boolean).join(' — ');
      return `
        <tr>
          <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;vertical-align:top;">
            <div style="font-weight:600;color:#111827;">${s.billingNumber}</div>
            <div style="color:#6b7280;font-size:13px;">${where}</div>
            ${s.workDate ? `<div style="color:#6b7280;font-size:12px;">Worked ${fmtDate(s.workDate)}</div>` : ''}
          </td>
          <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;vertical-align:top;text-align:right;">
            <a href="${url}" style="display:inline-block;background:#1E5A99;color:#fff;text-decoration:none;padding:8px 14px;border-radius:6px;font-weight:600;font-size:14px;">Add Photos</a>
          </td>
        </tr>`;
    }).join('');

    const rowsText = args.sheets.map(s => {
      const url = `${baseUrl}/billing-sheets?openSheet=${s.id}`;
      const where = [s.customerName, s.branchName, s.propertyAddress].filter(Boolean).join(' — ');
      return `- ${s.billingNumber} (${where})${s.workDate ? ` worked ${fmtDate(s.workDate)}` : ''}\n  ${url}`;
    }).join('\n');

    const subject = `Action needed: re-attach photos to ${args.sheets.length} of your billing sheet${args.sheets.length === 1 ? '' : 's'}`;

    const html = `
<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;line-height:1.5;color:#111827;max-width:640px;margin:0 auto;padding:20px;">
  <div style="background:#f59e0b;color:#fff;padding:20px;border-radius:10px 10px 0 0;">
    <h1 style="margin:0;font-size:22px;">Photos missing on your billing sheets</h1>
  </div>
  <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px;padding:24px;">
    <p>Hi ${args.technicianName},</p>
    <p>Due to a bug that has now been fixed, the photos you uploaded while creating the following billing sheet${args.sheets.length === 1 ? '' : 's'} were not saved. If those photos are still on your phone, please tap <strong>Add Photos</strong> on each sheet to re-attach them.</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0;">${rowsHtml}</table>
    <p style="color:#6b7280;font-size:13px;">Thanks for taking a moment to fix these — once the photos are back on the sheet you can ignore that sheet on the list.</p>
    <p style="color:#6b7280;font-size:12px;margin-top:24px;">— ${companyName}</p>
  </div>
</body></html>`;

    const text = `Hi ${args.technicianName},

Due to a bug that has now been fixed, the photos you uploaded while creating the following billing sheet${args.sheets.length === 1 ? '' : 's'} were not saved. If those photos are still on your phone, please open each sheet and tap "Add Photos" to re-attach them.

${rowsText}

Thanks,
${companyName}
`;

    try {
      await sgMail.send({
        from: DEFAULT_FROM_EMAIL,
        to: args.to,
        subject,
        html,
        text,
        categories: ['missing-photos-tech'],
      });
      return { success: true };
    } catch (error) {
      console.error('Failed to send missing-photos technician email:', error);
      const message = error instanceof Error ? error.message : 'Send failed';
      return { success: false, error: message };
    }
  }

  /**
   * Task #1887 — caller-supplied wording for {@link sendInvoiceDetailPdf}.
   *
   * The invoice mailer is one code path: fetch the stored PDF out of object
   * storage, base64 it, attach it, send. What it *says* is now the caller's
   * business, so a payment reminder can go out with its own subject, body and
   * company branding without a second invoice mailer existing to drift.
   *
   * Every field is optional and every default is exactly what the PDF-send
   * route sent before this parameter existed — passing nothing is byte-for-byte
   * the old email.
   */
  static async sendInvoiceDetailPdf(
    customerEmail: string,
    customerName: string,
    invoiceNumber: string,
    pdfUrl: string,
    overrides?: {
      subject?: string;
      html?: string;
      text?: string;
      /** Company profile email, so customer replies reach the company. */
      replyTo?: string | null;
      /** Attachment filename. Defaults to `Invoice_<number>_Detail.pdf`. */
      filename?: string;
      /** SendGrid categories, for per-send reporting. */
      categories?: string[];
    },
  ): Promise<{ success: boolean; error?: string }> {
    if (!isEmailConfigured()) {
      console.error('SENDGRID_API_KEY not configured');
      return { success: false, error: 'Email service not configured' };
    }

    try {
      // Download PDF from object storage
      const objectStorageService = new ObjectStorageService();
      const file = await objectStorageService.searchPublicObject(pdfUrl);
      
      if (!file) {
        return { success: false, error: 'PDF file not found in storage' };
      }

      // Read file content as buffer
      const chunks: Buffer[] = [];
      const stream = file.createReadStream();
      
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
      }
      
      const pdfBuffer = Buffer.concat(chunks);
      const pdfBase64 = pdfBuffer.toString('base64');

      const defaultSubject = `Invoice Detail Report - ${invoiceNumber}`;
      const defaultHtml = `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Invoice Detail Report</title>
          </head>
          <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="background: linear-gradient(135deg, #1E5A99, #0E3B6B); color: white; padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
              <h1 style="margin: 0; font-size: 28px;">Invoice Detail Report</h1>
              <p style="margin: 8px 0 0 0; font-size: 18px; opacity: 0.9;">IrrigoPro</p>
            </div>
            
            <div style="background: white; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px; padding: 30px;">
              <h2 style="color: #1f2937; margin-top: 0;">Hello ${customerName},</h2>
              
              <p style="font-size: 16px; color: #4b5563;">
                Please find attached the detailed work order breakdown for invoice <strong>${invoiceNumber}</strong>.
              </p>
              
              <p style="font-size: 16px; color: #4b5563;">
                This report provides a complete itemization of all work performed, parts used, labor hours, and associated costs for the billing period.
              </p>

              <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 20px; margin: 20px 0;">
                <p style="margin: 0; color: #1e40af; font-size: 14px;">
                  <strong>📎 Attachment:</strong> The detailed PDF report is attached to this email.
                </p>
              </div>

              <div style="border-top: 1px solid #e5e7eb; padding-top: 20px; margin-top: 30px;">
                <p style="color: #6b7280; font-size: 14px; margin: 0;">
                  If you have any questions about this invoice or the attached detail report, please don't hesitate to contact us.
                </p>
                <p style="color: #6b7280; font-size: 14px; margin: 8px 0 0 0;">
                  Thank you for your business!
                </p>
              </div>

              <div style="text-align: center; margin-top: 30px;">
                <p style="color: #9ca3af; font-size: 12px; margin: 0;">
                  This is an automated email from IrrigoPro
                </p>
              </div>
            </div>
          </body>
          </html>
        `;
      const defaultText = `
Invoice Detail Report - ${invoiceNumber}

Hello ${customerName},

Please find attached the detailed work order breakdown for invoice ${invoiceNumber}.

This report provides a complete itemization of all work performed, parts used, labor hours, and associated costs for the billing period.

If you have any questions about this invoice or the attached detail report, please don't hesitate to contact us.

Thank you for your business!

---
This is an automated email from IrrigoPro
        `;

      const replyTo =
        overrides?.replyTo && overrides.replyTo.trim().length > 0
          ? overrides.replyTo.trim()
          : undefined;

      // Send email with PDF attachment
      await sgMail.send({
        from: DEFAULT_FROM_EMAIL,
        ...(replyTo ? { replyTo } : {}),
        to: customerEmail,
        subject: overrides?.subject ?? defaultSubject,
        html: overrides?.html ?? defaultHtml,
        text: overrides?.text ?? defaultText,
        attachments: [
          {
            filename: overrides?.filename ?? `Invoice_${invoiceNumber}_Detail.pdf`,
            content: pdfBase64,
            type: 'application/pdf',
            disposition: 'attachment',
          },
        ],
        categories: overrides?.categories ?? ['invoice-detail-pdf'],
      });

      console.log(`Invoice detail PDF sent to ${customerEmail} for invoice ${invoiceNumber}`);
      return { success: true };
    } catch (error) {
      console.error('Failed to send invoice detail PDF:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  }

  // Task #743 — notify company admins and billing managers when
  // QuickBooks flips to reconnect_required. Throws on configuration /
  // send failure so the caller's per-recipient try/catch can skip
  // without rolling back the status update.
  static async sendQuickBooksReconnectRequiredEmail(args: {
    to: string;
    companyName: string;
    reason: string;
    dashboardUrl: string;
    runbookUrl: string;
  }): Promise<void> {
    if (!isEmailConfigured()) {
      throw new Error('Email service not configured (SENDGRID_API_KEY missing)');
    }
    const subject = `Action required: QuickBooks reconnection needed for ${args.companyName}`;
    const html = `
<p>Hello,</p>
<p>The QuickBooks integration for <strong>${args.companyName}</strong> requires reconnection.</p>
<p><strong>Reason:</strong> ${args.reason || 'Token refresh failed or token has expired.'}</p>
<p>Please reconnect QuickBooks to restore invoice syncing:</p>
<p><a href="${args.dashboardUrl}">Go to QuickBooks Settings</a></p>
<p>If you need help, refer to the <a href="${args.runbookUrl}">QuickBooks integration runbook</a>.</p>
<p>This email was sent because your account has the company admin or billing manager role. You will receive at most one notification per 24 hours.</p>
`.trim();
    const text = `Action required: QuickBooks reconnection needed for ${args.companyName}\n\nReason: ${args.reason || 'Token refresh failed or token has expired.'}\n\nReconnect here: ${args.dashboardUrl}\n\nRunbook: ${args.runbookUrl}`;
    await sgMail.send({
      from: DEFAULT_FROM_EMAIL,
      to: args.to,
      subject,
      html,
      text,
      categories: ['qb-reconnect-required'],
    });
  }

  // Task #693 — Financial Pulse Slice 4. Generic budget-alert email
  // hook used by services/budget-alert-service.ts. The dispatcher
  // pre-renders the HTML/text payload (template lives next to the
  // service); this method just forwards to SendGrid. Throws on
  // configuration / send failure so the service can record a per-
  // recipient error in its own try/catch.
  static async sendBudgetAlertEmail(args: {
    to: string;
    subject: string;
    html: string;
    text: string;
    tag?: string;
  }): Promise<void> {
    if (!isEmailConfigured()) {
      throw new Error('Email service not configured (SENDGRID_API_KEY missing)');
    }
    await sgMail.send({
      from: DEFAULT_FROM_EMAIL,
      to: args.to,
      subject: args.subject,
      html: args.html,
      text: args.text,
      categories: [args.tag || 'budget-alert'],
    });
  }

  // Send the signed estimate PDF to each company admin after a customer approval.
  // Called fire-and-forget from the approve-via-token handler; errors are logged
  // but never propagate to the caller so the approval response is unaffected.
  static async sendSignedEstimateCopyToAdmins(args: {
    adminEmails: string[];
    estimateNumber: string;
    customerName: string;
    signerName: string;
    pdfBuffer: Buffer;
    companyName: string;
  }): Promise<void> {
    if (!isEmailConfigured()) {
      console.warn('sendSignedEstimateCopyToAdmins: SENDGRID_API_KEY not set — skipping');
      return;
    }
    if (args.adminEmails.length === 0) return;

    const fmtNum = formatEstimateNumber(args.estimateNumber);
    const subject = `Signed Estimate ${fmtNum} — ${args.customerName}`;

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;line-height:1.6;color:#333;max-width:600px;margin:0 auto;padding:20px;">
  <div style="background:linear-gradient(135deg,#15803d,#166534);color:white;padding:24px 30px;border-radius:10px 10px 0 0;">
    <h1 style="margin:0;font-size:22px;">Estimate Approved &amp; Signed</h1>
    <p style="margin:6px 0 0;font-size:15px;opacity:.9;">${args.companyName}</p>
  </div>
  <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px;padding:28px;">
    <p style="font-size:16px;color:#1f2937;">
      <strong>${args.customerName}</strong> has approved and signed estimate <strong>${fmtNum}</strong>.
    </p>
    <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:16px 20px;margin:20px 0;">
      <table style="border-collapse:collapse;width:100%;">
        <tr>
          <td style="padding:4px 0;font-weight:600;color:#6b7280;width:120px;">Estimate</td>
          <td style="padding:4px 0;color:#111827;">${fmtNum}</td>
        </tr>
        <tr>
          <td style="padding:4px 0;font-weight:600;color:#6b7280;">Customer</td>
          <td style="padding:4px 0;color:#111827;">${args.customerName}</td>
        </tr>
        <tr>
          <td style="padding:4px 0;font-weight:600;color:#6b7280;">Signed by</td>
          <td style="padding:4px 0;color:#111827;">${args.signerName}</td>
        </tr>
      </table>
    </div>
    <p style="color:#4b5563;font-size:14px;">The signed PDF is attached to this email for your records.</p>
    <p style="color:#6b7280;font-size:12px;margin-top:24px;">— ${args.companyName}</p>
  </div>
</body>
</html>`;

    const text = `Estimate Approved & Signed — ${fmtNum}

${args.customerName} has approved and signed estimate ${fmtNum}.
Signed by: ${args.signerName}

The signed PDF is attached to this email for your records.

— ${args.companyName}`;

    const safeCustomer = args.customerName
      // eslint-disable-next-line no-control-regex
      .replace(/[\/\\:*?"<>|\x00-\x1f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const filename = safeCustomer
      ? `${safeCustomer} - ${fmtNum} (Signed).pdf`
      : `estimate-${fmtNum}-signed.pdf`;

    for (const adminEmail of args.adminEmails) {
      try {
        await sgMail.send({
          from: DEFAULT_FROM_EMAIL,
          to: adminEmail,
          subject,
          html,
          text,
          categories: ['estimate-signed-copy'],
          attachments: [
            {
              content: args.pdfBuffer.toString('base64'),
              filename,
              type: 'application/pdf',
              disposition: 'attachment',
            },
          ],
        });
      } catch (err) {
        console.error(`sendSignedEstimateCopyToAdmins: failed to email ${adminEmail}:`, err);
      }
    }
  }

  /**
   * Task #1544 — notifies company admins / managers that a customer clicked
   * "Request a new link" on an expired estimate approval page. Never sends a
   * link to the customer directly; the team re-sends via the Resend flow.
   */
  static async sendNewLinkRequestToAdmins(args: {
    adminEmails: string[];
    estimateNumber: string;
    customerName: string;
    customerEmail: string;
  }): Promise<void> {
    if (!isEmailConfigured()) {
      console.warn('sendNewLinkRequestToAdmins: SENDGRID_API_KEY not set — skipping');
      return;
    }
    const fmtNumber = formatEstimateNumber(args.estimateNumber);
    const subject = `[Action needed] ${args.customerName} requested a new approval link — Estimate ${fmtNumber}`;
    const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="font-family:Arial,sans-serif;line-height:1.6;color:#333;max-width:600px;margin:0 auto;padding:20px;">
  <div style="background:linear-gradient(135deg,#1E5A99,#0E3B6B);color:white;padding:24px 30px;border-radius:12px 12px 0 0;">
    <h1 style="margin:0;font-size:22px;">New Approval Link Requested</h1>
  </div>
  <div style="background:white;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;padding:28px;">
    <p style="font-size:15px;color:#374151;margin-top:0;">
      <strong>${this.escapeHtml(args.customerName)}</strong>
      (${this.escapeHtml(args.customerEmail)}) clicked "Request a new link" on the
      approval page for Estimate <strong>${this.escapeHtml(fmtNumber)}</strong>.
      Their previous link has expired.
    </p>
    <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:16px;margin:20px 0;">
      <p style="margin:0;color:#1e40af;font-size:14px;">
        <strong>Next step:</strong> Open the estimate in IrrigoPro and use the
        <em>Resend Approval Email</em> action to send them a fresh link to the email
        address on file. Do not reply to this notification with a link.
      </p>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:8px;">
      <tr><td style="padding:6px 0;font-weight:600;color:#6b7280;">Estimate:</td><td style="padding:6px 0;color:#1f2937;">${this.escapeHtml(fmtNumber)}</td></tr>
      <tr><td style="padding:6px 0;font-weight:600;color:#6b7280;">Customer:</td><td style="padding:6px 0;color:#1f2937;">${this.escapeHtml(args.customerName)}</td></tr>
      <tr><td style="padding:6px 0;font-weight:600;color:#6b7280;">Email on file:</td><td style="padding:6px 0;color:#1f2937;">${this.escapeHtml(args.customerEmail)}</td></tr>
    </table>
  </div>
</body>
</html>`;
    const text = `New Approval Link Requested\n\n${args.customerName} (${args.customerEmail}) requested a new approval link for Estimate ${fmtNumber}.\n\nNext step: open the estimate in IrrigoPro and use the Resend Approval Email action to send them a fresh link to the email address on file.\n`;

    for (const adminEmail of args.adminEmails) {
      try {
        await sgMail.send({
          from: { email: DEFAULT_FROM_EMAIL, name: SENDGRID_FROM_NAME },
          to: adminEmail,
          subject,
          html,
          text,
          categories: ['estimate-new-link-request'],
          customArgs: { estimateNumber: args.estimateNumber },
        });
      } catch (err: any) {
        console.error(`sendNewLinkRequestToAdmins: failed to email ${adminEmail}:`, err?.response?.body ?? err);
      }
    }
  }

  /**
   * Emails the customer-facing wet check condition report as a PDF attachment.
   * Subject: "Your Irrigation Inspection Results — {propertyAddress}"
   */
  static async sendWetCheckReport(args: {
    to: string;
    customerName: string;
    propertyAddress: string | null;
    technicianName: string | null;
    inspectionDate: string;
    companyName: string;
    companyEmail: string | null;
    companyPhone: string | null;
    pdfBuffer: Buffer;
    wetCheckId: number;
    note?: string;
  }): Promise<void> {
    if (!isEmailConfigured()) {
      throw new Error('Email is not configured: SENDGRID_API_KEY is missing. Report was not sent.');
    }

    const property = args.propertyAddress || args.customerName;
    const subject = `Your Irrigation Inspection Results — ${property}`;
    const filename = `${property.replace(/[/\\:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim()} - Inspection Report.pdf`;

    const replyToAddr =
      args.companyEmail && args.companyEmail.trim().length > 0
        ? args.companyEmail
        : undefined;

    const noteBlock = args.note && args.note.trim()
      ? `<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:16px 20px;margin:20px 0;color:#92400e;font-size:14px;line-height:1.5;white-space:pre-wrap;">${this.escapeHtml(args.note)}</div>`
      : '';

    const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="font-family:Arial,sans-serif;line-height:1.6;color:#333;max-width:600px;margin:0 auto;padding:20px;">
  <div style="background:linear-gradient(135deg,#1E5A99,#0E3B6B);color:white;padding:30px;border-radius:12px 12px 0 0;text-align:center;">
    <h1 style="margin:0;font-size:26px;">System Inspection Results</h1>
    <p style="margin:8px 0 0 0;font-size:16px;opacity:0.9;">${this.escapeHtml(args.companyName)}</p>
  </div>
  <div style="background:white;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;padding:30px;">
    <h2 style="color:#1f2937;margin-top:0;">Hello ${this.escapeHtml(args.customerName)},</h2>
    <p style="font-size:15px;color:#4b5563;">
      We've completed an irrigation inspection at <strong>${this.escapeHtml(property)}</strong>.
      Please find your full system condition report attached to this email.
    </p>
    ${noteBlock}
    <div style="background:#f9fafb;border-radius:8px;padding:20px;margin:20px 0;">
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr><td style="padding:6px 0;font-weight:600;color:#6b7280;">Property:</td><td style="padding:6px 0;color:#1f2937;">${this.escapeHtml(property)}</td></tr>
        <tr><td style="padding:6px 0;font-weight:600;color:#6b7280;">Inspection date:</td><td style="padding:6px 0;color:#1f2937;">${this.escapeHtml(args.inspectionDate)}</td></tr>
        ${args.technicianName ? `<tr><td style="padding:6px 0;font-weight:600;color:#6b7280;">Technician:</td><td style="padding:6px 0;color:#1f2937;">${this.escapeHtml(args.technicianName)}</td></tr>` : ''}
      </table>
    </div>
    <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:16px 20px;margin:20px 0;">
      <p style="margin:0;color:#1e40af;font-size:14px;"><strong>📎 Attachment:</strong> Your detailed condition report is attached to this email.</p>
    </div>
    <div style="border-top:1px solid #e5e7eb;padding-top:20px;margin-top:24px;">
      <p style="color:#6b7280;font-size:13px;margin:0;">Questions? Reply to this email or call us directly.</p>
      <div style="margin-top:12px;font-size:13px;color:#6b7280;">
        <p style="margin:3px 0;font-weight:600;color:#374151;">${this.escapeHtml(args.companyName)}</p>
        ${args.companyPhone ? `<p style="margin:3px 0;">📞 ${this.escapeHtml(args.companyPhone)}</p>` : ''}
        ${args.companyEmail ? `<p style="margin:3px 0;">✉️ ${this.escapeHtml(args.companyEmail)}</p>` : ''}
      </div>
    </div>
  </div>
</body>
</html>`;

    const text = `Irrigation Inspection Results — ${property}

Hello ${args.customerName},

We've completed an irrigation inspection at ${property}.
Your full system condition report is attached to this email.
${args.note && args.note.trim() ? `\nNote from ${args.companyName}:\n${args.note}\n` : ''}
Inspection date: ${args.inspectionDate}${args.technicianName ? `\nTechnician: ${args.technicianName}` : ''}

Questions? Reply to this email or call us directly.

—
${args.companyName}${args.companyPhone ? `\n${args.companyPhone}` : ''}${args.companyEmail ? `\n${args.companyEmail}` : ''}
`;

    try {
      await sgMail.send({
        from: { email: DEFAULT_FROM_EMAIL, name: SENDGRID_FROM_NAME },
        ...(replyToAddr ? { replyTo: replyToAddr } : {}),
        to: args.to,
        subject,
        html,
        text,
        categories: ['wet-check-report'],
        customArgs: { wetCheckId: String(args.wetCheckId) },
        attachments: [
          {
            filename,
            content: args.pdfBuffer.toString('base64'),
            type: 'application/pdf',
            disposition: 'attachment',
          },
        ],
      });
    } catch (error: any) {
      const sgErrors = error?.response?.body?.errors;
      const sgReason = Array.isArray(sgErrors)
        ? sgErrors.map((e: any) => e?.message).filter((m: unknown): m is string => typeof m === 'string' && m.length > 0).join('; ')
        : '';
      const baseMsg = (error instanceof Error && error.message) || 'Unknown SendGrid error';
      throw new Error(
        sgReason
          ? `SendGrid rejected the report email: ${sgReason}`
          : `Failed to send report email: ${baseMsg}`,
      );
    }
  }

  /**
   * Emails the customer-facing Irrigation System Profile as a PDF attachment.
   * Subject: "Your Irrigation System Profile — {property}"
   */
  static async sendIrrigationProfileReport(args: {
    to: string;
    customerName: string;
    propertyAddress: string | null;
    companyName: string;
    companyEmail: string | null;
    companyPhone: string | null;
    pdfBuffer: Buffer;
    customerId: number;
  }): Promise<void> {
    if (!isEmailConfigured()) {
      throw new Error(
        'Email is not configured: SENDGRID_API_KEY is missing. Report was not sent.',
      );
    }

    const property = args.propertyAddress || args.customerName;
    const subject = `Your Irrigation System Profile — ${property}`;
    const filename = `${property
      .replace(/[/\\:*?"<>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()} - Irrigation Profile.pdf`;

    const replyToAddr =
      args.companyEmail && args.companyEmail.trim().length > 0
        ? args.companyEmail
        : undefined;

    const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="font-family:Arial,sans-serif;line-height:1.6;color:#333;max-width:600px;margin:0 auto;padding:20px;">
  <div style="background:linear-gradient(135deg,#1E5A99,#0E3B6B);color:white;padding:30px;border-radius:12px 12px 0 0;text-align:center;">
    <h1 style="margin:0;font-size:26px;">Irrigation System Profile</h1>
    <p style="margin:8px 0 0 0;font-size:16px;opacity:0.9;">${this.escapeHtml(args.companyName)}</p>
  </div>
  <div style="background:white;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;padding:30px;">
    <h2 style="color:#1f2937;margin-top:0;">Hello ${this.escapeHtml(args.customerName)},</h2>
    <p style="font-size:15px;color:#4b5563;">
      Please find your irrigation system profile report attached to this email.
      It includes details for each controller, program, and zone at
      <strong>${this.escapeHtml(property)}</strong>.
    </p>
    <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:16px 20px;margin:20px 0;">
      <p style="margin:0;color:#1e40af;font-size:14px;">
        <strong>&#128206; Attachment:</strong> Your irrigation system profile report is attached to this email.
      </p>
    </div>
    <div style="border-top:1px solid #e5e7eb;padding-top:20px;margin-top:24px;">
      <p style="color:#6b7280;font-size:13px;margin:0;">Questions? Reply to this email or call us directly.</p>
      <div style="margin-top:12px;font-size:13px;color:#6b7280;">
        <p style="margin:3px 0;font-weight:600;color:#374151;">${this.escapeHtml(args.companyName)}</p>
        ${args.companyPhone ? `<p style="margin:3px 0;">&#128222; ${this.escapeHtml(args.companyPhone)}</p>` : ''}
        ${args.companyEmail ? `<p style="margin:3px 0;">&#9993; ${this.escapeHtml(args.companyEmail)}</p>` : ''}
      </div>
    </div>
  </div>
</body>
</html>`;

    const text = `Irrigation System Profile — ${property}

Hello ${args.customerName},

Please find your irrigation system profile report attached to this email.
It includes details for each controller, program, and zone at ${property}.

Questions? Reply to this email or call us directly.

—
${args.companyName}${args.companyPhone ? `\n${args.companyPhone}` : ''}${args.companyEmail ? `\n${args.companyEmail}` : ''}
`;

    try {
      await sgMail.send({
        from: { email: DEFAULT_FROM_EMAIL, name: SENDGRID_FROM_NAME },
        ...(replyToAddr ? { replyTo: replyToAddr } : {}),
        to: args.to,
        subject,
        html,
        text,
        categories: ['irrigation-profile-report'],
        customArgs: { customerId: String(args.customerId) },
        attachments: [
          {
            filename,
            content: args.pdfBuffer.toString('base64'),
            type: 'application/pdf',
            disposition: 'attachment',
          },
        ],
      });
    } catch (error: any) {
      const sgErrors = error?.response?.body?.errors;
      const sgReason = Array.isArray(sgErrors)
        ? sgErrors
            .map((e: any) => e?.message)
            .filter((m: unknown): m is string => typeof m === 'string' && m.length > 0)
            .join('; ')
        : '';
      const baseMsg = (error instanceof Error && error.message) || 'Unknown SendGrid error';
      throw new Error(
        sgReason
          ? `SendGrid rejected the irrigation profile email: ${sgReason}`
          : `Failed to send irrigation profile email: ${baseMsg}`,
      );
    }
  }
}
