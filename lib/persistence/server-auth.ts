/**
 * DEVELOPMENT-ONLY authentication for the embedded persistence route.
 *
 * The token is NOT a secret: NEXT_PUBLIC_PERSISTENCE_TOKEN is compiled into
 * the public browser bundle, so it is fully visible to every visitor and
 * provides no confidentiality and no user isolation — anyone who can load the
 * page can read and write EVERY learner partition and all documents by
 * supplying an arbitrary x-learner-key. Its only purpose is to keep unrelated
 * network scanners out of a trusted-network endpoint. Suitable only for
 * localhost or trusted-network, single-user deployments. Production must
 * replace this module with real session verification and derive learner
 * identity from server-controlled claims.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import type { AssetPrincipal } from '@openmaic/storage';
import type { RuntimeHttpPrincipal } from '@openmaic/storage/server';

type PersistencePrincipal = RuntimeHttpPrincipal & Partial<Pick<AssetPrincipal, 'key'>>;

/**
 * The single asset partition for this deployment shape. Documents have no
 * ownership partition; assets get the same treatment until real auth lands.
 */
const SHARED_ASSET_PRINCIPAL = 'shared';

const ACCESS_COOKIE = 'openmaic_access';

function readCookie(cookieHeader: string | undefined | null, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const item of cookieHeader.split(';')) {
    const eq = item.indexOf('=');
    if (eq === -1 || item.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(item.slice(eq + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Personal-deployment option (PERSISTENCE_ALLOW_COOKIE_AUTH=true): accept the
 * site's HMAC-signed access-code cookie as an alternative to the Bearer
 * token. Media elements cannot attach Authorization headers, so streaming
 * narration/images directly from <audio src>/<img src> needs cookie auth.
 * The HMAC cookie is only minted after the ACCESS_CODE gate, so this keeps
 * the same "anyone past the site gate" trust boundary as the Bearer token.
 */
function verifyAccessCookie(cookieValue: string | undefined): boolean {
  const accessCode = process.env.ACCESS_CODE;
  if (process.env.PERSISTENCE_ALLOW_COOKIE_AUTH !== 'true' || !accessCode || !cookieValue) {
    return false;
  }
  const dot = cookieValue.indexOf('.');
  if (dot === -1) return false;
  const timestamp = cookieValue.slice(0, dot);
  const signature = cookieValue.slice(dot + 1);
  const expected = createHmac('sha256', accessCode).update(timestamp).digest('hex');
  if (signature.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function secureEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function authenticatePersistenceCredentials(
  authorization: string | undefined,
  learnerKey: string | undefined,
  accessCookie: string | undefined,
): PersistencePrincipal | undefined {
  const token = process.env.PERSISTENCE_DEV_TOKEN;
  if (
    token &&
    authorization &&
    secureEqual(authorization, `Bearer ${token}`)
  ) {
    // 同上：共享资产分区 + learnerKey 仅分区运行时会话
    return { key: SHARED_ASSET_PRINCIPAL, ...(learnerKey ? { learnerKey } : {}) };
  }

  // 个人部署选项：访问码 cookie（经站点门禁签发）等价放行
  if (verifyAccessCookie(accessCookie)) {
    return { key: SHARED_ASSET_PRINCIPAL, ...(learnerKey ? { learnerKey } : {}) };
  }

  return undefined;
}

export function authenticatePersistenceHeaders(headers: Headers): PersistencePrincipal | undefined {
  return authenticatePersistenceCredentials(
    headers.get('authorization') ?? undefined,
    headers.get('x-learner-key') ?? undefined,
    readCookie(headers.get('cookie'), ACCESS_COOKIE),
  );
}

export async function authenticatePersistenceRequest(
  req: IncomingMessage,
): Promise<PersistencePrincipal | undefined> {
  return authenticatePersistenceCredentials(
    singleHeader(req.headers.authorization),
    singleHeader(req.headers['x-learner-key']),
    readCookie(singleHeader(req.headers.cookie), ACCESS_COOKIE),
  );
}
