import type { Session } from './connectors';

/** The fields of Electron's `Cookie` used here. Kept structural so this module loads without Electron (tests run in Node). */
export interface BrowserCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  session?: boolean;
  expirationDate?: number;
  sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
}

// Chromium treats an unspecified SameSite as Lax.
const SAME_SITE = { unspecified: 'Lax', no_restriction: 'None', lax: 'Lax', strict: 'Strict' } as const;

/**
 * Converts the cookies of the in-app login window into the Playwright storage state the uploader reuses.
 * Electron already writes domain cookies with a leading dot and host-only cookies without one, as Playwright expects.
 */
export function toSession(cookies: BrowserCookie[], origins: Session['origins'] = []): Session {
  return {
    cookies: cookies.filter(c => c.domain).map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain!,
      path: c.path || '/',
      expires: c.session || c.expirationDate === undefined ? -1 : c.expirationDate,
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
      sameSite: SAME_SITE[c.sameSite ?? 'unspecified'],
    })),
    origins,
  };
}

/** Top-level pages the login window may show: Mitene itself, over HTTPS only. */
export function loginPageAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ['mitene.us', 'family-album.com'].some(host => u.hostname === host || u.hostname.endsWith(`.${host}`));
  } catch { return false; }
}

/** The uploader is only reachable after login; elsewhere (the login page) Mitene redirects. */
export function onUploader(url: string): boolean {
  try { const u = new URL(url); return u.hostname === 'mitene.us' && u.pathname.startsWith('/web/uploader'); } catch { return false; }
}
