import { Outlet } from 'react-router-dom';
import { ApprovalDock } from '@/components/ApprovalDock';

export function App() {
  return (
    <>
      <div className="app">
        <Outlet />
      </div>
      <ApprovalDock />
    </>
  );
}
