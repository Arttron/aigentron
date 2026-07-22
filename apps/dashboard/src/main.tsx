import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import './globals.css';
import { App } from './App';
import { TaskListPage } from './pages/TaskListPage';
import { AgentsPage } from './pages/AgentsPage';
import { TaskDetailPage } from './pages/TaskDetailPage';
import { SettingsPage } from './pages/SettingsPage';
import { StatsPage } from './pages/StatsPage';

const router = createBrowserRouter([
  {
    element: <App />,
    children: [
      { path: '/', element: <TaskListPage /> },
      { path: '/agents', element: <AgentsPage /> },
      { path: '/tasks/:id', element: <TaskDetailPage /> },
      { path: '/settings', element: <SettingsPage /> },
      { path: '/stats', element: <StatsPage /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
