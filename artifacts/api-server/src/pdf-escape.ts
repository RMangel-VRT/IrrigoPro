/**
 * Canonical HTML escaper for every PDF renderer.
 *
 * PDF bodies are assembled as HTML strings and handed to Chromium, so any
 * customer-editable text (addresses, notes, controller labels) interpolated
 * raw can alter the rendered document. This lives in its own module because
 * estimate-pdf-html.ts imports pdf-helpers.ts; a shared helper in either of
 * those would be an import cycle.
 */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
