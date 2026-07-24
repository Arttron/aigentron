import { Outlet } from 'react-router-dom';
import { ApprovalDock } from '@/components/ApprovalDock';
import { ThemeToggle } from '@/components/ThemeToggle';

export function App() {
  return (
    <>
      <div className="app">
        <Outlet />
      </div>
      <ApprovalDock />
      <ThemeToggle />
    </>
  );
}
