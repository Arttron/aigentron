import { Outlet } from 'react-router-dom';
import { ApprovalDock } from '@/components/ApprovalDock';
import { ThemeToggle } from '@/components/ThemeToggle';
import { AdminChat } from '@/components/AdminChat';
import { AuthGate } from '@/components/AuthGate';
import { ScrollTopButton } from '@/components/ScrollTopButton';

export function App() {
  return (
    <AuthGate>
      <div className="app">
        <Outlet />
      </div>
      <ApprovalDock />
      <AdminChat />
      <ThemeToggle />
      <ScrollTopButton />
    </AuthGate>
  );
}
