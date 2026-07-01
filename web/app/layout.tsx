import type { Metadata } from 'next';
import './global.css';

export const metadata: Metadata = {
  title: 'Workday Auto-Apply Agent - OMP Control Plane',
  description: 'Local TypeScript Workday auto-apply agent',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <div className="glow-container" aria-hidden="true">
          <div className="glow-blob blob-1"></div>
          <div className="glow-blob blob-2"></div>
        </div>
        {children}
      </body>
    </html>
  );
}
