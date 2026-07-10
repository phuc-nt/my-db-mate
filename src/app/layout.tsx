import type { Metadata } from 'next';
import './globals.css';
import { AppNav } from '../components/app-nav';

export const metadata: Metadata = {
  title: 'My DB Mate',
  description: 'Chat with your database — safely.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
        <AppNav />
        {children}
      </body>
    </html>
  );
}
