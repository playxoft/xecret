import type { MetadataRoute } from 'next';

import { absoluteUrl, SITE_HOST } from '@/lib/site';

/**
 * What a crawler may read.
 *
 * `/app` and `/api` are disallowed not as a security control — both authenticate
 * every request, and a `robots.txt` has never stopped anybody — but because
 * crawling them produces nothing but redirects and 401s, and a site whose index
 * is mostly error pages ranks worse for the pages that do matter.
 *
 * Single-use links (`/invite`, `/reset-password`, `/cli/authorize`) are
 * disallowed for the same reason plus one more: those URLs land in email, and
 * email lands in places that fetch every link in it.
 *
 * `host` names which of the deployment's hostnames is the real one. It still
 * earns its place now that `xecret.playxoft.com` is settled: a Worker answers
 * on its `*.workers.dev` hostname as well as its custom domain, and staging
 * answers on its own, so more than one hostname serves this content whatever
 * the canonical one is. It takes a bare host, never a URL — see `SITE_HOST`.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/api/', '/app/', '/invite/', '/reset-password', '/reset-pin', '/cli/'],
      },
    ],
    sitemap: absoluteUrl('/sitemap.xml'),
    host: SITE_HOST,
  };
}
