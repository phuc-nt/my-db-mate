/**
 * SSRF guard for outbound webhook URLs.
 *
 * Lives here rather than beside either caller because both the scheduler and the
 * action triggers deliver to user-supplied URLs, and having one own it made the
 * two import each other in a cycle. The guard has no scheduling or trigger
 * concepts in it — it is a URL policy over `node:dns` and `node:net`.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** True if an IP address string is private/loopback/link-local/ULA or a mapped
 *  form of one. Handles IPv4, IPv4-mapped IPv6 (::ffff:a.b.c.d), and IPv6. */
function isPrivateIp(ip: string): boolean {
  // Normalize IPv4-mapped IPv6 (::ffff:169.254.169.254) to its IPv4 form.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const v4 = mapped ? mapped[1] : (isIP(ip) === 4 ? ip : null);
  if (v4) {
    const [a, b] = v4.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true;              // loopback
  if (/^(fe8|fe9|fea|feb)/.test(lower)) return true;                            // link-local
  if (/^(fc|fd)/.test(lower)) return true;                                      // unique-local
  if (/^::ffff:/.test(lower)) return true;                                      // any other mapped → treat as private-ish, safer
  return false;
}

/**
 * SSRF guard: resolves the host and rejects if ANY resolved address is
 * private/loopback/link-local/metadata (code-review C1/C2). Also rejects
 * non-http(s), bare single-label hosts, and literal private IPs in any encoding.
 * Returns the vetted IP so the caller can pin it (prevents DNS rebinding).
 */
export async function vetWebhookUrl(raw: string): Promise<{ ok: boolean; pinnedIp?: string; reason?: string }> {
  let u: URL;
  try { u = new URL(raw); } catch { return { ok: false, reason: 'invalid URL' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, reason: 'protocol not http(s)' };
  const host = u.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  // Explicit per-host:port opt-in for private webhook targets (dev/E2E receivers,
  // LAN automation like a local n8n). Empty by default; each entry must match
  // exactly — this is NOT a blanket bypass of the SSRF guard.
  const allow = (process.env.WEBHOOK_PRIVATE_ALLOWLIST ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (allow.includes(`${host}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`)) return { ok: true };
  if (host === 'localhost') return { ok: false, reason: 'localhost' };
  if (!host.includes('.') && isIP(host) === 0) return { ok: false, reason: 'bare single-label host' };

  // Literal IP (any form isIP recognizes) → check directly.
  if (isIP(host) !== 0) {
    return isPrivateIp(host) ? { ok: false, reason: `private IP ${host}` } : { ok: true, pinnedIp: host };
  }
  // DNS name → resolve ALL addresses; reject if any is private (rebinding-safe).
  try {
    const addrs = await lookup(host, { all: true });
    if (addrs.length === 0) return { ok: false, reason: 'no DNS record' };
    for (const a of addrs) if (isPrivateIp(a.address)) return { ok: false, reason: `resolves to private ${a.address}` };
    return { ok: true, pinnedIp: addrs[0].address };
  } catch (e) {
    return { ok: false, reason: `DNS lookup failed: ${e instanceof Error ? e.message : e}` };
  }
}
