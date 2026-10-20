/**
 * Which URLs a webhook may be pointed at.
 *
 * A webhook endpoint is a URL a customer types and this server then fetches,
 * signed, on every write — which makes it a request-forgery primitive if it can
 * name something the customer could not otherwise reach. On Cloudflare the
 * Worker cannot reach a private network at all, so most of the classic targets
 * are closed by the platform; this closes them in the code as well, because a
 * self-hoster may run the same code somewhere that is not true.
 *
 * The rules, all checked on the parsed URL rather than the string:
 *
 *  - `https:` only. A webhook carries a signature and the names of a customer's
 *    secrets; neither belongs on the wire in the clear.
 *  - No userinfo. Credentials in a URL end up in logs.
 *  - No IP literal in a private, loopback, link-local, unique-local, CGNAT,
 *    multicast or reserved range, v4 or v6 — including the v4-mapped v6 forms.
 *  - No host that names the machine or its network: `localhost`, and the
 *    `.localhost`, `.local`, `.internal`, `.lan`, `.home.arpa` suffixes.
 *
 * What it cannot do is resolve DNS: a public name that resolves to a private
 * address is not caught here. The platform is what catches that, and
 * `docs/self-hosting.md` says so for anyone running the code elsewhere.
 */

export const WEBHOOK_URL_MAX_LENGTH = 2048;

export type WebhookUrlProblem =
  'malformed' | 'notHttps' | 'credentials' | 'privateAddress' | 'localName' | 'tooLong';

export interface WebhookUrlCheck {
  readonly valid: boolean;
  readonly problem?: WebhookUrlProblem;
  readonly message?: string;
}

const MESSAGES: Readonly<Record<WebhookUrlProblem, string>> = {
  malformed: 'Enter a full URL, starting with https://.',
  notHttps: 'A webhook URL must use https.',
  credentials: 'A webhook URL may not contain a username or password.',
  privateAddress: 'A webhook URL may not point at a private, loopback or reserved address.',
  localName: 'A webhook URL may not point at a local host name.',
  tooLong: `A webhook URL may be at most ${WEBHOOK_URL_MAX_LENGTH} characters.`,
};

const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa'];

function refuse(problem: WebhookUrlProblem): WebhookUrlCheck {
  return { valid: false, problem, message: MESSAGES[problem] };
}

export function checkWebhookUrl(raw: string): WebhookUrlCheck {
  if (raw.length > WEBHOOK_URL_MAX_LENGTH) return refuse('tooLong');

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse('malformed');
  }

  if (url.protocol !== 'https:') return refuse('notHttps');
  if (url.username !== '' || url.password !== '') return refuse('credentials');

  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === '') return refuse('malformed');

  if (host.startsWith('[') && host.endsWith(']')) {
    return isPublicIpv6(host.slice(1, -1)) ? { valid: true } : refuse('privateAddress');
  }

  const v4 = parseIpv4(host);
  if (v4 !== null) return isPublicIpv4(v4) ? { valid: true } : refuse('privateAddress');

  if (host === 'localhost' || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return refuse('localName');
  }
  // A single label — `intranet`, `db` — is resolved against a search domain,
  // which is to say against the network the server sits on.
  if (!host.includes('.')) return refuse('localName');

  return { valid: true };
}

/** Dotted-quad only; the URL parser has already normalised hex and octal forms. */
function parseIpv4(host: string): [number, number, number, number] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (match === null) return null;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return null;
  return octets as [number, number, number, number];
}

function isPublicIpv4([a, b, c]: [number, number, number, number]): boolean {
  if (a === 0 || a === 10 || a === 127) return false; // this network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 169 && b === 254) return false; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast and reserved
  return true;
}

function isPublicIpv6(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower === '::' || lower === '::1') return false;

  // v4-mapped and v4-compatible: judged by the v4 address they carry. The URL
  // parser renders `::ffff:127.0.0.1` as `::ffff:7f00:1`, so both spellings
  // are handled.
  const mapped = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped !== null) {
    const v4 = parseIpv4(mapped[1]!);
    return v4 !== null && isPublicIpv4(v4);
  }
  const mappedHex = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (mappedHex !== null) {
    const high = parseInt(mappedHex[1]!, 16);
    const low = parseInt(mappedHex[2]!, 16);
    return isPublicIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
  }

  const first = parseInt(lower.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
  if ((first & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((first & 0xff00) === 0xff00) return false; // multicast
  if (lower.startsWith('2001:db8:') || lower === '2001:db8::') return false; // documentation
  if (lower.startsWith('64:ff9b:')) return false; // NAT64, which reaches v4 private ranges
  return true;
}
