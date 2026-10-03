import { useEffect, useState } from 'react';

export type KespTheme = 'dark' | 'light';

/** Documents the useKespTheme behavior. */
export function useKespTheme(defaultTheme: KespTheme = 'dark') {
  const [theme, setTheme] = useState<KespTheme>(/** Handles the callback for this operation. */() => {
    const saved = localStorage.getItem('kesp-theme') as KespTheme | null;
    return saved === 'light' || saved === 'dark' ? saved : defaultTheme;
  });

  useEffect(/** Handles the callback for this operation. */() => {
    localStorage.setItem('kesp-theme', theme);
  }, [theme]);

  const toggleTheme = /** Documents the toggleTheme behavior. */ () => {
    setTheme(/** Handles the callback for this operation. */(current) => (current === 'dark' ? 'light' : 'dark'));
  };

  return { theme, setTheme, toggleTheme };
}
