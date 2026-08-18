import Link from 'next/link';

import { ArrowRightIcon } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { formatDate, postHref } from '../_lib/posts';
import type { PostMeta } from '../_lib/posts';

/**
 * One post in a list.
 *
 * ── Why the whole card is one link ──
 * A card with a linked title and a separately linked "Read more" gives a
 * keyboard user two tab stops to the same place, gives a screen reader two
 * entries in its link list, and gives a mouse user a large target that does
 * nothing when clicked. So the card *is* the anchor, and everything else in it
 * is text. The arrow is decorative and marked as such.
 *
 * @param featured Lays the card out horizontally, at display sizes — used for
 *   the newest post at the top of the index.
 */
export function PostCard({ post, featured = false }: { post: PostMeta; featured?: boolean }) {
  return (
    <Link
      href={postHref(post.slug)}
      className={cn(
        'group border-line bg-surface hover:border-line-strong flex h-full flex-col rounded-xl border p-5 transition-colors sm:p-6',
        featured && 'sm:flex-row sm:items-center sm:gap-10 sm:p-8',
      )}
    >
      <div className={cn('flex flex-1 flex-col', featured && 'sm:max-w-2xl')}>
        <div className="text-fg-subtle flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
          <span className="border-line text-fg-muted rounded-full border px-2 py-0.5 font-medium">
            {post.category}
          </span>
          {/* `<time>` with a machine-readable attribute: the visible string is
              for a person, `dateTime` is for everything else that reads a page. */}
          <time dateTime={post.published}>{formatDate(post.published)}</time>
          <span aria-hidden="true">·</span>
          <span>{post.minutes} min read</span>
        </div>

        <h3
          className={cn(
            'text-fg mt-3 leading-snug font-semibold tracking-[-0.015em] text-balance',
            featured ? 'text-2xl sm:text-[1.75rem]' : 'text-lg',
          )}
        >
          {post.title}
        </h3>

        <p
          className={cn(
            'text-fg-muted mt-2.5 leading-7',
            featured ? 'text-base' : 'line-clamp-3 text-sm leading-6',
          )}
        >
          {post.description}
        </p>

        <span
          className={cn(
            'text-fg mt-4 inline-flex items-center gap-1.5 text-sm font-medium',
            !featured && 'mt-auto pt-4',
          )}
        >
          Read the post
          <ArrowRightIcon
            aria-hidden="true"
            className="size-3.5 transition-transform group-hover:translate-x-0.5"
          />
        </span>
      </div>
    </Link>
  );
}
