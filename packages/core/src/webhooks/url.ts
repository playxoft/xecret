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
 *  - No IP literal in a private, loopback, link-local, site-local,
 *    unique-local, CGNAT, multicast, discard-only or reserved range, v4 or v6 —
 *    and none of the v6 forms that carry or reach a v4 address: v4-mapped,
 *    v4-compatible, SIIT (`::ffff:0:0/96`), NAT64 (`64:ff9b::/96`), 6to4
 *    (`2002::/16`) and Teredo (`2001::/32`) (review round 1, L10).
 *  - No host that names the machine or its network: `localhost`, and the
 *    `.localhost`, `.local`, `.internal`, `.lan`, `.home.arpa` suffixes.
 *
 * What it cannot do is resolve DNS: a public name that resolves to a private
 * address — or is re-pointed at one after the URL was saved, which is DNS
 * rebinding — passes every rule here. On Cloudflare Workers the platform
 * closes that, because a Worker's `fetch` has no route into a private network.
 * Anywhere else it is open, and the "Webhook egress" entry in
 * `docs/self-hosting.md` (and the public self-hosting page) says what to put in
 * front of it.
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

/**
 * The eight 16-bit pieces of an IPv6 address, or `null` when it is not one.
 *
 * Judged on the pieces rather than on the text, because the text has more than
 * one spelling for every address — `2001:0:…` and `2001::…`, `::ffff:7f00:1`
 * and `::ffff:127.0.0.1` — and a prefix test on one spelling misses the others.
 * The URL parser has already put the address in its canonical compressed form;
 * a dotted v4 tail is accepted anyway.
 */
function ipv6Pieces(address: string): number[] | null {
  let text = address;
  const tail: number[] = [];
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted !== null) {
    const v4 = parseIpv4(dotted[2]!);
    if (v4 === null) return null;
    tail.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
    const head = dotted[1]!;
    text = head.endsWith('::') ? head : head.slice(0, -1);
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string | undefined): number[] | null => {
    if (part === undefined || part === '') return [];
    const pieces: number[] = [];
    for (const piece of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
      pieces.push(parseInt(piece, 16));
    }
    return pieces;
  };
  const left = parse(halves[0]);
  const right = parse(halves[1]);
  if (left === null || right === null) return null;

  const given = left.length + right.length + tail.length;
  if (halves.length === 1) return given === 8 ? [...left, ...tail] : null;
  if (given > 7) return null;
  return [...left, ...Array<number>(8 - given).fill(0), ...right, ...tail];
}

function isPublicIpv6(address: string): boolean {
  const p = ipv6Pieces(address.toLowerCase());
  if (p === null) return false;
  const [p0, p1, p2, p3, p4, p5, p6, p7] = p as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const zeroTo = (end: number) => p.slice(0, end).every((piece) => piece === 0);
  const carriedV4 = (): [number, number, number, number] => [
    p6 >> 8,
    p6 & 0xff,
    p7 >> 8,
    p7 & 0xff,
  ];

  if (zeroTo(8)) return false; // unspecified ::
  if (zeroTo(7) && p7 === 1) return false; // loopback ::1
  // v4-mapped (::ffff:0:0/96) and the deprecated v4-compatible (::/96): judged
  // by the v4 address they carry.
  if (zeroTo(5) && p5 === 0xffff) return isPublicIpv4(carriedV4());
  if (zeroTo(6)) return isPublicIpv4(carriedV4());
  // SIIT, v4-translated (::ffff:0:0:0/96): a v4 address in v6 clothing, refused
  // whole — no public webhook is reached that way.
  if (zeroTo(4) && p4 === 0xffff && p5 === 0) return false;

  if ((p0 & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
  if ((p0 & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((p0 & 0xffc0) === 0xfec0) return false; // site-local fec0::/10, deprecated but routed by some stacks
  if ((p0 & 0xff00) === 0xff00) return false; // multicast ff00::/8
  if (p0 === 0x0100 && p1 === 0 && p2 === 0 && p3 === 0) return false; // discard-only 100::/64
  if (p0 === 0x2001 && p1 === 0x0db8) return false; // documentation 2001:db8::/32
  if (p0 === 0x2001 && p1 === 0) return false; // Teredo 2001::/32, a tunnel to any v4 address
  if (p0 === 0x2002) return false; // 6to4 2002::/16, likewise
  if (p0 === 0x0064 && p1 === 0xff9b) return false; // NAT64 64:ff9b::/96 and 64:ff9b:1::/48
  return true;
}
