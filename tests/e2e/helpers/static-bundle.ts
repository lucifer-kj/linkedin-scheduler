import fs from 'node:fs';
import path from 'node:path';

export interface ExtractedAssets {
  sameOriginScripts: string[];
  sameOriginStyles: string[];
  externalUrls: string[];
}

export function extractHtmlAssets(html: string): ExtractedAssets {
  const sameOriginScripts: string[] = [];
  const sameOriginStyles: string[] = [];
  const externalUrls: string[] = [];

  const scriptRegex = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRegex.exec(html)) !== null) {
    const src = match[1].trim();
    if (/^(https?:)?\/\//i.test(src)) {
      externalUrls.push(src);
    } else if (src.length > 0) {
      sameOriginScripts.push(src.startsWith('/') ? src : `/${src}`);
    }
  }

  const linkRegex = /<link\b[^>]*>/gi;
  while ((match = linkRegex.exec(html)) !== null) {
    const tag = match[0];
    const relMatch = /\brel\s*=\s*["']([^"']+)["']/i.exec(tag);
    const hrefMatch = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (!hrefMatch) continue;
    const rel = (relMatch?.[1] ?? '').toLowerCase();
    const href = hrefMatch[1].trim();
    if (rel.includes('stylesheet') || href.endsWith('.css')) {
      if (/^(https?:)?\/\//i.test(href)) {
        externalUrls.push(href);
      } else if (href.length > 0) {
        sameOriginStyles.push(href.startsWith('/') ? href : `/${href}`);
      }
    }
  }

  return {
    sameOriginScripts: Array.from(new Set(sameOriginScripts)),
    sameOriginStyles: Array.from(new Set(sameOriginStyles)),
    externalUrls: Array.from(new Set(externalUrls)),
  };
}

export function isValidHtmlDocument(html: string): boolean {
  const lower = html.toLowerCase();
  return (
    html.trim().length > 0 &&
    (lower.includes('<!doctype html') || lower.includes('<html')) &&
    lower.includes('</html>') &&
    (lower.includes('<body') || lower.includes('<head'))
  );
}

export function readLocalDistPublicIndex(): {
  exists: boolean;
  filePath: string;
  html: string | null;
} {
  const candidates = [
    path.resolve(process.cwd(), 'dist', 'public', 'index.html'),
    path.resolve(process.cwd(), 'linkedin-scheduler', 'dist', 'public', 'index.html'),
  ];

  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      return {
        exists: true,
        filePath,
        html: fs.readFileSync(filePath, 'utf8'),
      };
    }
  }

  return {
    exists: false,
    filePath: candidates[0],
    html: null,
  };
}
