// The blog renders its markdown through the documentation's renderer, so it
// needs the documentation's prose stylesheet. Imported rather than copied: two
// stylesheets for one `.doc-prose` class is two definitions of what a heading
// looks like, and the second one drifts the first time somebody adjusts a
// margin. Next.js dedupes the file by path, so importing it in both places
// ships it once.
import '../docs/docs.css';

export default function BlogLayout({ children }: LayoutProps<'/blog'>) {
  return children;
}
