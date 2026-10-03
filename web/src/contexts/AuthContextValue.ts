import { createContext } from 'react';
import type { User } from 'firebase/auth';

export interface AuthContextType {
  user: User | null;
  loading: boolean;
  error: string | null;
  isEmailAllowed: boolean;
  signInWithGoogle: () => Promise<void>;
  signInWithPassword: (username: string, password: string) => Promise<void>;
  switchAccountWithGoogle: () => Promise<void>;
  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined);
