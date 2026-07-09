import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'My DB Mate',
  description: 'Chat with your database — safely.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
        {children}
      </body>
    </html>
  );
}
