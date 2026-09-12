'use client';

import { cn } from '@/lib/cn';
import { Badge, TableCell, TableRow, Tooltip } from '@/components/ui';
import { ComparedValue } from './compared-value';
import type { ComparedEnvironment } from './use-compared-secrets';

/**
 * A key one of the environments on screen holds and this one does not.
 *
 * ── Why the row exists ──
 * The table used to be a list of *this* environment's keys with the others
 * shown alongside, which meant a key missing here had nowhere to appear: the
 * banner counted them — "staging has three keys production does not" — and that
 * was all. But "which environment is missing what" is the main question
 * somebody opens several environments to answer, and the count is the one part
 * of the answer nobody can act on. So the table is the union of every key in
 * every environment on screen, and a key absent from one of them shows an empty
 * cell there rather than being left out of the table.
 *
 * ── Why it is a different row component ──
 * `SecretRow` is built around a stored secret: it renames it, declares its type,
 * deletes it, stages it into the save bar's batch and offers its version
 * history. None of that exists for a key this environment has never held, and a
 * row that rendered all of it disabled would be a row of dead controls. What is
 * left is the name and one cell per environment — which is exactly what this is.
 *
 * ── Every cell writes itself ──
 * Including the column for the environment the page is about. The save bar
 * speaks for a batch staged against stored rows, and there is no stored row
 * here to stage against; each cell is a `ComparedValue`, so each carries its own
 * Save, its own error, and — where the environment is production — its own
 * confirmation. Creating the key here is what turns this into an ordinary row on
 * the next listing.
 */
export function AbsentRow({
  secretName,
  environments,
  revealedIn,
  onCreated,
  onHistory,
  onDirtyChange,
}: {
  secretName: string;
  /**
   * Every environment on screen, the page's own first.
   *
   * The page's environment arrives shaped as a compared one — same listing, same
   * IO, same truncation flag — because from this row's point of view it is one:
   * another column that may or may not hold the key, with its own key material
   * and its own production status.
   */
  environments: readonly ComparedEnvironment[];
  /** Plaintext already decrypted and audited for a given environment, if any. */
  revealedIn: (slug: string) => string | undefined;
  /** A cell wrote the key into its environment; that listing needs rereading. */
  onCreated: (slug: string) => void;
  onHistory: (slug: string) => void;
  onDirtyChange: (slug: string, dirty: boolean) => void;
}) {
  /** The environments that do hold it, for the line under the name. */
  const holders = environments.filter((environment) => environment.byName.has(secretName));

  return (
    <TableRow className="h-14">
      {/* No checkbox. The bulk actions are this environment's deletes, and there
          is nothing of this environment's in the row to act on. An empty cell
          keeps the three columns aligned with every row above it. */}
      <TableCell className="pr-0 align-top" />

      <TableCell className="align-top">
        <div className="flex h-9 min-w-0 flex-col justify-center">
          <span className="flex min-w-0 items-center gap-2">
            {/* Plain text, not the input every stored row has: renaming a key
                that does not exist here is not a thing, and a field that looked
                editable and silently did nothing would be worse than a label. */}
            <span
              className={cn('text-fg truncate font-mono text-sm')}
              title={secretName}
              // The name is the row's label for everything in it, and the cells
              // beside it name only their environment.
              id={`absent-${secretName}`}
            >
              {secretName}
            </span>
            <Tooltip
              content={
                holders.length === 0
                  ? 'Not stored in any environment on screen.'
                  : `Stored in ${holders.map((environment) => environment.name).join(', ')}. Not in every environment on screen.`
              }
            >
              {/* The span is the trigger, so Radix has an element of its own to
                  write `data-state` onto rather than the badge's span. */}
              <span className="inline-flex shrink-0">
                <Badge tone="warning">Missing</Badge>
              </span>
            </Tooltip>
          </span>
        </div>
      </TableCell>

      <TableCell className="align-top">
        <div className="flex flex-col gap-1.5">
          {environments.map((environment) => (
            <ComparedValue
              key={environment.slug}
              environment={environment}
              secretName={secretName}
              secret={environment.byName.get(secretName) ?? null}
              {...(() => {
                const revealed = revealedIn(environment.slug);
                return revealed === undefined ? {} : { revealed };
              })()}
              disabled={environment.loading}
              onDirtyChange={(dirty) => onDirtyChange(environment.slug, dirty)}
              onHistory={() => onHistory(environment.slug)}
              onSaved={() => onCreated(environment.slug)}
            />
          ))}
        </div>
      </TableCell>
    </TableRow>
  );
}
