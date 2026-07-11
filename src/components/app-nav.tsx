'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/connections', label: 'Connections' },
  { href: '/library', label: 'Library' },
];

/** Slim global top bar. Hidden on share pages — anonymous viewers get no app chrome. */
export function AppNav() {
  const pathname = usePathname();
  if (pathname.startsWith('/share/')) return null;

  return (
    <nav className="border-b border-neutral-200 dark:border-neutral-800">
      <div className="mx-auto flex h-12 max-w-5xl items-center gap-5 px-6 text-sm">
        <Link href="/connections" className="font-semibold">My DB Mate</Link>
        {LINKS.map((l) => {
          const active = pathname === l.href || pathname.startsWith(l.href + '/');
          return (
            <Link key={l.href} href={l.href}
              className={active ? 'font-medium text-blue-600' : 'text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100'}>
              {l.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
