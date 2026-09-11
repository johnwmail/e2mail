const DANGEROUS_TAGS = /<\/?(?:script|iframe|object|embed|link|meta|base|form|input|button|textarea|select|svg|math)[^>]*>/gi;

/**
 * Conservative HTML sanitiser for React Native WebView (JS disabled).
 * Strips executable tags/handlers and javascript: URLs. Remote images can be
 * rewritten separately via `rewriteRemoteImages`.
 */
export function sanitizeMailHtml(html: string): string {
  if (!html) return '';
  let out = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  out = out.replace(/<style[\s\S]*?<\/style>/gi, (block) =>
    block
      .replace(/@import\b[^;]*;?/gi, '')
      .replace(/url\(\s*['"]?\s*https?:/gi, 'url(about:blank')
      .replace(/expression\s*\(/gi, 'noexpr(')
  );
  out = out.replace(DANGEROUS_TAGS, '');
  out = out.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  out = out.replace(/(href|src|xlink:href)\s*=\s*(['"])\s*javascript:[^'"]*\2/gi, '$1=$2#$2');
  out = out.replace(/(href|src|xlink:href)\s*=\s*(['"])\s*data:text\/html[^'"]*\2/gi, '$1=$2#$2');
  return out;
}

/** Replace http(s) image sources so the WebView never fetches them unauthenticated. */
export function rewriteRemoteImages(html: string, allowRemote: boolean): string {
  if (allowRemote) return html;
  return html.replace(
    /(<img\b[^>]*?\bsrc\s*=\s*)(['"])https?:\/\/[^'"]*\2/gi,
    '$1$2$2 alt="blocked"'
  );
}

export function replaceCidImages(
  html: string,
  cidToDataUri: Record<string, string>
): string {
  let out = html;
  for (const [cid, uri] of Object.entries(cidToDataUri)) {
    const escaped = cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`cid:${escaped}`, 'gi'), uri);
  }
  return out;
}

export function isPgpArmored(text: string | undefined): boolean {
  return typeof text === 'string' && /-----BEGIN PGP (MESSAGE|SIGNED MESSAGE)-----/.test(text);
}

export function wrapMailDocument(body: string, dark: boolean): string {
  const color = dark ? '#f8fafc' : '#0f172a';
  const bg = dark ? '#0f172a' : '#ffffff';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5"/>
<style>
  html,body{margin:0;padding:8px;background:${bg};color:${color};
    font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:16px;line-height:1.45;}
  img{max-width:100%;height:auto;}
  a{color:${dark ? '#93c5fd' : '#2563eb'};}
</style></head><body>${body}</body></html>`;
}
