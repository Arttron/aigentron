import type { Metadata } from 'next';
import './globals.css';
import { ApprovalDock } from '@/components/ApprovalDock';

export const metadata: Metadata = {
  title: 'Local Dev Server — Agent Fleet',
  description: 'Orchestration dashboard for autonomous Claude Code agents.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="app">{children}</div>
        <ApprovalDock />
      </body>
    </html>
  );
}
