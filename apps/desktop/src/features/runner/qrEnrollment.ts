/**
 * Standards-compliant QR generation for Runner enrollment payloads.
 * Uses the `qrcode` library (ISO/IEC 18004 Model 2, full ECC).
 */

import QRCode from 'qrcode';

/** Render enrollment payload as an SVG string suitable for inline display. */
export async function renderEnrollmentQrSvg(payload: string, options: { width?: number; margin?: number } = {}): Promise<string> {
  const text = String(payload || '');
  if (!text) return '';
  return QRCode.toString(text, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: options.margin ?? 2,
    width: options.width ?? 180,
    color: {
      dark: '#1c1917',
      light: '#ffffff',
    },
  });
}

/** Render enrollment payload as a PNG data URL (for tests / export). */
export async function renderEnrollmentQrPngDataUrl(payload: string, options: { width?: number; margin?: number } = {}): Promise<string> {
  const text = String(payload || '');
  if (!text) return '';
  return QRCode.toDataURL(text, {
    errorCorrectionLevel: 'M',
    margin: options.margin ?? 2,
    width: options.width ?? 256,
    color: {
      dark: '#1c1917',
      light: '#ffffff',
    },
  });
}

/** Synchronous SVG for environments that already have a pre-rendered string. Prefer async API. */
export function emptyQrSvgPlaceholder(): string {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" role="img" aria-label="QR loading"></svg>';
}
