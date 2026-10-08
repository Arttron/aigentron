import { createContext, useContext } from 'react';
import type { AuthStatus } from './auth';

/** The sign-in status of this browser, shared by the app (set by AuthGate). */
export const AuthContext = createContext<{ status: AuthStatus | null; refresh: () => void }>({ status: null, refresh: () => undefined });
export const useAuth = () => useContext(AuthContext);
