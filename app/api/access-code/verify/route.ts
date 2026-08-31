import { cookies, headers } from 'next/headers';
import { timingSafeEqual } from 'crypto';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { createAccessToken } from '@/lib/server/access-token';

export async function POST(request: Request) {
  const accessCode = process.env.ACCESS_CODE;
  if (!accessCode) {
    return apiSuccess({ valid: true });
  }

  let body: { code?: string };
  try {
    body = await request.json();
  } catch {
    return apiError('INVALID_REQUEST', 400, 'Invalid JSON body');
  }

  // Constant-time comparison
  if (!body.code) {
    return apiError('INVALID_REQUEST', 401, 'Invalid access code');
  }
  const encoder = new TextEncoder();
  const a = encoder.encode(body.code);
  const b = encoder.encode(accessCode);
  if (a.byteLength !== b.byteLength || !timingSafeEqual(a, b)) {
    return apiError('INVALID_REQUEST', 401, 'Invalid access code');
  }

  const token = createAccessToken(accessCode);
  // The Secure attribute is only honored on HTTPS origins: behind an HTTP
  // frontend (e.g. self-hosted Traefik on a LAN), a Secure cookie is silently
  // dropped by the browser and every later API call 401s while the verify
  // response itself looked successful. Follow the actual request scheme —
  // the reverse proxy reports it via x-forwarded-proto — and fall back to
  // NODE_ENV only when no proxy header exists (direct access).
  const forwardedProto = (await headers()).get('x-forwarded-proto');
  const secureCookie = forwardedProto
    ? forwardedProto.split(',')[0].trim() === 'https'
    : process.env.NODE_ENV === 'production';
  const cookieStore = await cookies();
  cookieStore.set('openmaic_access', token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 7, // 7 days
    secure: secureCookie,
  });

  return apiSuccess({ valid: true });
}
