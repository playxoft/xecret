import {
  ARCHIVE_FORMAT,
  ARCHIVE_FORMAT_VERSION,
  ARCHIVE_MAX_PARTS,
  ARCHIVE_REASON,
  canonicalEnvironment,
  canonicalSecret,
  serializeArchiveDocument,
} from './document';
import type {
  ArchiveEnvironment,
  ArchiveSecret,
  ArchiveVault,
  VaultArchiveDocument,
} from './document';
import { ArchiveTooLargeError } from './errors';
import { writeStoredZip } from './zip';

/**
 * Writing a vault escape archive: planning the parts, and turning each into the
 * bytes of a file.
 *
 * ── What the writer is given, and what it never sees ──
 * Ciphertext and public values, already in their stored text forms — blob
 * strings, base64url, hex. The server assembles that from its own rows and hands
 * it over verbatim; nothing here derives, opens or re-encrypts anything, and
 * nothing could, because no key is in reach. The archive's "no plaintext" claim
 * is therefore structural on this side, and the sweep test in
 * `build.test.ts` checks it against the output anyway.
 *
 * ── Planning and encoding are separate on purpose ──
 * A split archive is planned all at once — which secret goes in which part has
 * to be decided before part 1 can say how many parts there are — but encoded one
 * part at a time. The parts share the input's strings rather than copying them,
 * so planning costs references, and a caller sending each part as it is encoded
 * holds one part's bytes at a time, not all of them. In a Worker with 128 MB,
 * that difference is the difference.
 *
 * Spec: docs/security/e2ee-crypto-spec.md §14.
 */

/**
 * The reference writer's ceiling for one part's ZIP file (§14.6): 8 MiB, so
 * that one part base64-encoded into an email stays under the mail provider's
 * 15 MB per message with room for the message itself.
 */
export const ARCHIVE_PART_BUDGET_BYTES = 8 * 1024 * 1024;

/** What a writer is handed: the account, its vault, and its environments. */
export interface ArchiveInput {
  userId: string;
  vault: ArchiveVault;
  environments: readonly ArchiveEnvironment[];
}

export interface ArchivePlanOptions {
  /** One per archive; the same in every part. */
  archiveId: string;
  createdAt: Date;
  /**
   * Until when the old vault can still be recovered in the product, for the
   * README. `null` when the archive outlives any such window.
   */
  retainedUntil: Date | null;
  /** Defaults to {@link ARCHIVE_PART_BUDGET_BYTES}. */
  maxPartBytes?: number;
  /** Defaults to {@link ARCHIVE_MAX_PARTS}. A caller may be stricter, never looser. */
  maxParts?: number;
}

/** One part, ready to attach or save. */
export interface ArchiveFile {
  fileName: string;
  bytes: Uint8Array;
}

/**
 * Plans the parts of one archive: which environment and which secret goes where.
 *
 * Deterministic: environments are ordered by organisation, project and
 * environment name, keys by version, secrets by name — compared by code unit,
 * not by locale — so the same vault produces the same parts whatever order a
 * database returned its rows in.
 *
 * Greedy and conservative. Each part's size is estimated from the exact
 * serialisation of every entry at its real indentation, plus a margin, and
 * {@link encodeArchivePart} refuses a part that came out larger than the budget
 * anyway, so an estimate that is ever wrong fails loudly rather than producing
 * an email the provider bounces.
 */
export function planArchiveParts(
  input: ArchiveInput,
  options: ArchivePlanOptions,
): VaultArchiveDocument[] {
  const maxPartBytes = options.maxPartBytes ?? ARCHIVE_PART_BUDGET_BYTES;
  const maxParts = Math.min(options.maxParts ?? ARCHIVE_MAX_PARTS, ARCHIVE_MAX_PARTS);
  const createdAt = options.createdAt.toISOString();

  const environments = [...input.environments]
    .map((environment) => ({
      ...environment,
      keys: [...environment.keys].sort((a, b) => a.edkVersion - b.edkVersion),
      secrets: [...environment.secrets].sort((a, b) => compare(a.name, b.name)),
    }))
    .sort(
      (a, b) =>
        compare(a.orgName, b.orgName) ||
        compare(a.projectName, b.projectName) ||
        compare(a.environmentName, b.environmentName) ||
        compare(a.environmentId, b.environmentId),
    );

  const skeleton = (part: number, parts: number, chunk: ArchiveEnvironment[]) =>
    document(input, options.archiveId, createdAt, part, parts, chunk);

  // Everything a part carries whatever its contents: the ZIP's headers, the
  // README (rendered as if there were the most parts, the longest it gets), and
  // the document with no environments in it.
  const fixed =
    ZIP_OVERHEAD_BYTES +
    utf8Length(
      archiveReadme(skeleton(maxParts, maxParts, []), { retainedUntil: options.retainedUntil }),
    ) +
    utf8Length(serializeArchiveDocument(skeleton(maxParts, maxParts, [])));
  const margin = Math.ceil(maxPartBytes / 100) + 4096;
  const budget = maxPartBytes - fixed - margin;

  const parts: ArchiveEnvironment[][] = [];
  let current: ArchiveEnvironment[] = [];
  let used = 0;

  const closePart = () => {
    parts.push(current);
    current = [];
    used = 0;
  };

  for (const environment of environments) {
    const header = environmentHeaderBytes(environment);
    const secretSizes = environment.secrets.map(secretBytes);
    const smallest = header + (secretSizes[0] ?? 0);

    // Every secret must fit an otherwise empty part beside its environment's
    // header, or no packing exists. Checked up front so the loop below can never
    // close a part with nothing in it.
    // A reduce, not `Math.max(...sizes)`: spreading a hundred thousand arguments
    // overflows the call stack.
    const largest = secretSizes.reduce((max, size) => Math.max(max, size), 0);
    if (header + largest > budget) {
      throw new ArchiveTooLargeError(
        'One environment entry is larger than an archive part may be.',
      );
    }
    if (used + smallest > budget && current.length > 0) closePart();

    let chunk: ArchiveSecret[] = [];
    used += header;

    environment.secrets.forEach((secret, index) => {
      const size = secretSizes[index]!;
      if (used + size > budget) {
        // This part is full. The environment continues in the next one, with
        // its metadata and keys repeated so that part opens on its own (§14.6).
        current.push({ ...environment, secrets: chunk });
        closePart();
        chunk = [];
        used = header;
      }
      chunk.push(secret);
      used += size;
    });

    current.push({ ...environment, secrets: chunk });
  }

  if (current.length > 0 || parts.length === 0) closePart();

  if (parts.length > maxParts) {
    throw new ArchiveTooLargeError(
      `This vault needs ${parts.length} archive parts, more than the ${maxParts} allowed.`,
    );
  }

  return parts.map((chunk, index) => skeleton(index + 1, parts.length, chunk));
}

/**
 * Encodes one planned part as the bytes of its ZIP file, and refuses one larger
 * than the budget it was planned against.
 */
export function encodeArchivePart(
  doc: VaultArchiveDocument,
  options: { retainedUntil: Date | null; maxPartBytes?: number },
): ArchiveFile {
  const encoder = new TextEncoder();
  const bytes = writeStoredZip(
    [
      {
        name: 'README.txt',
        data: encoder.encode(archiveReadme(doc, { retainedUntil: options.retainedUntil })),
      },
      { name: 'archive.json', data: encoder.encode(serializeArchiveDocument(doc)) },
    ],
    new Date(doc.createdAt),
  );

  const limit = options.maxPartBytes ?? ARCHIVE_PART_BUDGET_BYTES;
  if (bytes.length > limit) {
    throw new ArchiveTooLargeError('An archive part came out larger than its size budget.');
  }

  return { fileName: archiveFileName(doc), bytes };
}

/** `xecret-vault-archive-YYYY-MM-DD.zip`, or `…-part-K-of-N.zip` (§14.1). Informative only. */
export function archiveFileName(
  doc: Pick<VaultArchiveDocument, 'createdAt' | 'part' | 'parts'>,
): string {
  const day = doc.createdAt.slice(0, 10);
  const suffix = doc.parts > 1 ? `-part-${doc.part}-of-${doc.parts}` : '';
  return `xecret-vault-archive-${day}${suffix}.zip`;
}

/**
 * `README.txt` (§14.3). Plain ASCII, LF line endings, wrapped to fit a terminal.
 *
 * The warning is in capitals and comes before the instructions on purpose: this
 * file will be found years from now by somebody deciding whether it is safe to
 * leave lying around, and that is the sentence they need first.
 */
export function archiveReadme(
  doc: Pick<VaultArchiveDocument, 'createdAt' | 'part' | 'parts' | 'account'>,
  options: { retainedUntil: Date | null },
): string {
  const made = doc.createdAt.replace('T', ' at ').replace(/:\d\d\.\d{3}Z$/, ' UTC');
  const lines = [
    'xecret vault archive',
    '====================',
    '',
    'This file is an encrypted copy of the secrets in an xecret vault. It was made',
    `on ${made}, when the vault of account`,
    `${doc.account.userId} was reset.`,
  ];

  if (doc.parts > 1) {
    lines.push(
      '',
      `This is part ${doc.part} of ${doc.parts}. Each part opens on its own, with the same`,
      'passphrase or recovery code, and holds different secrets.',
    );
  }

  lines.push(
    '',
    'WARNING: ANYONE WHO GETS THIS FILE CAN ATTACK YOUR PASSPHRASE',
    '',
    '  This file can be copied. Whoever has a copy can try passphrases against it',
    '  on their own computers, as fast and for as long as they like. There is no',
    '  rate limit and no lockout, and no deletion or revocation can ever take that',
    '  ability away. A strong passphrase holds; a weak one will not.',
    '',
    '  Keep this file somewhere private. Delete the copies you do not need,',
    '  including the email it came in.',
    '',
    'WHAT IS INSIDE',
    '',
    "  archive.json holds the latest value of every secret in the vault's",
    '  end-to-end encrypted environments, still encrypted exactly as xecret stored',
    '  them. The names of your organisations, projects, environments and secrets',
    '  are in plain text.',
    '',
    'WHAT OPENS IT',
    '',
    '  Only the master passphrase of that vault, or one of its unused recovery',
    '  codes. Nobody else can open it: not xecret, and not your teammates.',
    '',
    'HOW TO OPEN IT',
    '',
    '  - With the xecret command-line tool, offline and with no account:',
    '',
    '        xecret vault open-archive <this file>',
    '',
    '  - In xecret: open a project, choose "Import archive", and pick this file.',
    '    It is decrypted in your browser. Your passphrase is never sent anywhere.',
  );

  if (options.retainedUntil !== null) {
    const until = options.retainedUntil
      .toISOString()
      .replace('T', ' at ')
      .replace(/:\d\d\.\d{3}Z$/, ' UTC');
    lines.push(
      '',
      'YOUR OLD VAULT IS KEPT FOR SEVEN DAYS',
      '',
      `  Until ${until}, xecret keeps the old vault itself, and`,
      '  you can recover it in the app with the same passphrase or a recovery code:',
      '  Account settings, Vault, "Recover a previous vault". After that, xecret',
      '  deletes it, and this file is the only copy.',
    );
  }

  lines.push(
    '',
    'THE FORMAT',
    '',
    '  The format is specified in section 14 of docs/security/e2ee-crypto-spec.md',
    '  in the xecret source code, so this file can be opened without xecret.',
    '',
  );

  return lines.join('\n');
}

/* ───────────────────────────────── sizes ───────────────────────────────── */

/**
 * The ZIP's own bytes for the two entries: a local header and a central-directory
 * header per entry, both carrying the name, and the end record.
 */
const ZIP_OVERHEAD_BYTES = (30 + 46) * 2 + 'README.txt'.length * 2 + 'archive.json'.length * 2 + 22;

/**
 * An environment's bytes without its secrets, as it sits in the document: each
 * line indented four more spaces than `JSON.stringify` puts it, plus the comma
 * and newline between entries.
 */
function environmentHeaderBytes(environment: ArchiveEnvironment): number {
  return indentedBytes(
    JSON.stringify(canonicalEnvironment({ ...environment, secrets: [] }), null, 2),
    4,
  );
}

/** One secret's bytes in the document, indented eight spaces deep. */
function secretBytes(secret: ArchiveSecret): number {
  return indentedBytes(JSON.stringify(canonicalSecret(secret), null, 2), 8);
}

function indentedBytes(serialized: string, indent: number): number {
  const lines = serialized.split('\n').length;
  return utf8Length(serialized) + lines * indent + 2;
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function document(
  input: ArchiveInput,
  archiveId: string,
  createdAt: string,
  part: number,
  parts: number,
  environments: ArchiveEnvironment[],
): VaultArchiveDocument {
  return {
    format: ARCHIVE_FORMAT,
    formatVersion: ARCHIVE_FORMAT_VERSION,
    archiveId,
    part,
    parts,
    createdAt,
    reason: ARCHIVE_REASON,
    account: { userId: input.userId },
    vault: input.vault,
    environments,
  };
}
