import { Outlet } from 'react-router-dom';
import { ApprovalDock } from '@/components/ApprovalDock';
import { ThemeToggle } from '@/components/ThemeToggle';
import { AdminChat } from '@/components/AdminChat';
import { AuthGate } from '@/components/AuthGate';
import { ScrollTopButton } from '@/components/ScrollTopButton';
import { AppNav } from '@/components/AppNav';

export function App() {
  return (
    <AuthGate>
      <AppNav />
      <div className="app-shell">
        <div className="app">
          <Outlet />
        </div>
      </div>
      <ApprovalDock />
      <AdminChat />
      <ThemeToggle />
      <ScrollTopButton />
    </AuthGate>
  );
}
