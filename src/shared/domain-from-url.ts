import { getDomain } from 'tldts';

export function urlToRegistrableDomain(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const d = getDomain(u.hostname);
    if (d) return d;
    if (u.hostname) return u.hostname;
    return null;
  } catch {
    return null;
  }
}
