import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom';
import './globals.css';
import { installAuthFetch } from './lib/auth';
import { App } from './App';

installAuthFetch();

/** Page background while a route chunk loads — no empty/white flash (the colour comes from globals.css). */
function Fallback() {
  return <div style={{ minHeight: '100vh', background: 'var(--bg, transparent)' }} />;
}

const router = createBrowserRouter([
  // Outside <App/> on purpose: no sign-in gate, no chat widget — the one-time token in the URL is the credential.
  { path: '/secret/:token', lazy: async () => ({ Component: (await import('./pages/SecretLinkPage')).SecretLinkPage }), HydrateFallback: Fallback },
  {
    element: <App />,
    HydrateFallback: Fallback,
    children: [
      { path: '/', lazy: async () => ({ Component: (await import('./pages/TaskListPage')).TaskListPage }) },
      { path: '/agents', lazy: async () => ({ Component: (await import('./pages/AgentsPage')).AgentsPage }) },
      { path: '/tasks/:id', lazy: async () => ({ Component: (await import('./pages/TaskDetailPage')).TaskDetailPage }) },
      { path: '/settings', lazy: async () => ({ Component: (await import('./pages/SettingsPage')).SettingsPage }) },
      { path: '/stats', lazy: async () => ({ Component: (await import('./pages/StatsPage')).StatsPage }) },
      { path: '/resources', lazy: async () => ({ Component: (await import('./pages/ResourcesPage')).ResourcesPage }) },
      { path: '/knowledge', lazy: async () => ({ Component: (await import('./pages/KnowledgePage')).KnowledgePage }) },
      { path: '/workspace', lazy: async () => ({ Component: (await import('./pages/WorkspacePage')).WorkspacePage }) },
      { path: '/projects', lazy: async () => ({ Component: (await import('./pages/ProjectsPage')).ProjectsPage }) },
      { path: '/projects/:slug', lazy: async () => ({ Component: (await import('./pages/ProjectPage')).ProjectPage }) },
      { path: '/addons', lazy: async () => ({ Component: (await import('./pages/AddonsPage')).AddonsPage }) },
      // the old address of the browser page (bookmarks, links in docs)
      { path: '/browser', element: <Navigate to="/addons?tab=browser" replace /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
