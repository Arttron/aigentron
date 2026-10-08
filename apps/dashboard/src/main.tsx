import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import './globals.css';
import { installAuthFetch } from './lib/auth';
import { App } from './App';
import { TaskListPage } from './pages/TaskListPage';
import { AgentsPage } from './pages/AgentsPage';
import { TaskDetailPage } from './pages/TaskDetailPage';
import { SettingsPage } from './pages/SettingsPage';
import { StatsPage } from './pages/StatsPage';
import { SecretLinkPage } from './pages/SecretLinkPage';
import { ResourcesPage } from './pages/ResourcesPage';

installAuthFetch();

const router = createBrowserRouter([
  // Outside <App/> on purpose: no sign-in gate, no chat widget — the one-time token in the URL is the credential.
  { path: '/secret/:token', element: <SecretLinkPage /> },
  {
    element: <App />,
    children: [
      { path: '/', element: <TaskListPage /> },
      { path: '/agents', element: <AgentsPage /> },
      { path: '/tasks/:id', element: <TaskDetailPage /> },
      { path: '/settings', element: <SettingsPage /> },
      { path: '/stats', element: <StatsPage /> },
      { path: '/resources', element: <ResourcesPage /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
