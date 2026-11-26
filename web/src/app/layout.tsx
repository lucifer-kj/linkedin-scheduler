import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
});

export const metadata: Metadata = {
  title: 'LinkedIn Post Scheduler | NestJS + BullMQ + Next.js',
  description:
    'Multi-tenant LinkedIn post scheduler with AES-256-GCM token encryption, BullMQ delayed jobs, and exponential backoff retries.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable} h-full`}>
      <body className="min-h-full font-sans antialiased bg-[#090B10] text-slate-50 overflow-x-hidden">
        {children}
      </body>
    </html>
  );
}
