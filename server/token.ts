/**
 * HMAC 令牌签发与校验：管理后台与站点访问密码共用。
 *
 * 令牌格式：v2.<role>.<expiresAt>.<nonce>.<signature>
 * 签名覆盖角色、有效期与随机数，expiresAt 到期后服务端直接拒绝。
 * 角色写入令牌本身：同一入口输入的密码不同，拿到的权限也不同。
 */

const encoder = new TextEncoder()

export type TokenRole = 'view' | 'edit' | 'admin'

const ROLES: TokenRole[] = ['view', 'edit', 'admin']

export interface TokenPayload {
  expiresAt: number
  role: TokenRole
}

export function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const hmacKeys = new Map<string, Promise<CryptoKey>>()

function hmacKey(secret: string): Promise<CryptoKey> {
  const cached = hmacKeys.get(secret)
  if (cached) return cached
  const key = crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  hmacKeys.set(secret, key)
  if (hmacKeys.size > 8) {
    const oldest = hmacKeys.keys().next().value
    if (oldest) hmacKeys.delete(oldest)
  }
  return key
}

/** 先各自哈希再逐字节比较，避免长度不同时的提前返回泄漏信息 */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ])
  const x = new Uint8Array(left)
  const y = new Uint8Array(right)
  let diff = 0
  for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i]
  return diff === 0
}

async function tokenSignature(secret: string, payload: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(secret),
    encoder.encode(payload),
  )
  return base64url(new Uint8Array(signature))
}

export async function createToken(
  secret: string,
  ttlMs: number,
  role: TokenRole,
): Promise<{ token: string; expiresAt: number }> {
  const expiresAt = Date.now() + ttlMs
  const nonceBytes = new Uint8Array(8)
  crypto.getRandomValues(nonceBytes)
  const payload = `v2.${role}.${expiresAt}.${base64url(nonceBytes)}`
  return { token: `${payload}.${await tokenSignature(secret, payload)}`, expiresAt }
}

export async function verifyToken(
  token: string,
  secret: string,
): Promise<TokenPayload | null> {
  const parts = token.split('.')
  if (parts.length !== 5 || parts[0] !== 'v2') return null
  const role = parts[1] as TokenRole
  if (!ROLES.includes(role)) return null
  const expiresAt = Number(parts[2])
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null
  const payload = `${parts[0]}.${parts[1]}.${parts[2]}.${parts[3]}`
  const expected = await tokenSignature(secret, payload)
  if (!(await constantTimeEqual(expected, parts[4]))) return null
  return { expiresAt, role }
}
