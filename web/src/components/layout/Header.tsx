import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Phone,
  Upload,
  Settings,
  Globe,
  LogIn,
  LogOut,
  Moon,
  Sun,
  UserRoundSearch,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { isUsingEmulators } from '@/services/firebaseApp';
import { useAuth } from '@/contexts/useAuth';
import { useTheme } from 'next-themes';

const navItems = [
  { path: '/call-analyzer', labelKey: 'nav.callAnalyzer', icon: UserRoundSearch },
  { path: '/calls', labelKey: 'nav.calls', icon: Phone },
  { path: '/upload', labelKey: 'nav.upload', icon: Upload },
];

/** Renders the Header component. */
export function Header() {
  const { t, i18n } = useTranslation();
  const location = useLocation();
  const { user, logout, switchAccountWithGoogle } = useAuth();
  const { theme, setTheme } = useTheme();

  const changeLanguage = /** Documents the changeLanguage behavior. */ (lng: string) => {
    i18n.changeLanguage(lng);
  };

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-14 items-center">
        <div className="mr-4 flex items-center space-x-3">
          <Link to="/call-analyzer" className="mr-6 flex items-center space-x-2">
            <Phone className="h-6 w-6" />
            <span className="font-bold">{t('app.title')}</span>
          </Link>
          {isUsingEmulators && (
            <span className="rounded-full border border-amber-400 bg-amber-500/10 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-amber-500">
              Emulator
            </span>
          )}
          {import.meta.env.VITE_APP_ENV === 'test' && (
            <span className="rounded-full border border-orange-400 bg-orange-500/10 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-orange-500">
              Test
            </span>
          )}
        </div>

        <nav className="flex items-center space-x-6 text-sm font-medium">
          {navItems.map(/** Handles the callback for this operation. */(item) => {
            const Icon = item.icon;
            const isActive = location.pathname === item.path;

            return (
              <Link
                key={item.path}
                to={item.path}
                className={cn(
                  'flex items-center space-x-2 transition-colors hover:text-foreground/80',
                  isActive ? 'text-foreground' : 'text-foreground/60'
                )}
              >
                <Icon className="h-4 w-4" />
                <span>{t(item.labelKey)}</span>
              </Link>
            );
          })}
        </nav>

        <div className="flex flex-1 items-center justify-end space-x-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={/** Handles the onClick interaction. */ () => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
            <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
            <span className="sr-only">{t('nav.theme')}</span>
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon">
                <Globe className="h-4 w-4" />
                <span className="sr-only">{t('nav.language')}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={/** Handles the onClick interaction. */ () => changeLanguage('en')}>
                English
              </DropdownMenuItem>
              <DropdownMenuItem onClick={/** Handles the onClick interaction. */ () => changeLanguage('es')}>
                Español
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-2">
                {user?.photoURL ? (
                  <img
                    src={user.photoURL}
                    alt=""
                    className="h-6 w-6 rounded-full"
                  />
                ) : (
                  <Settings className="h-4 w-4" />
                )}
                <span className="hidden sm:inline-block max-w-[150px] truncate">
                  {user?.email}
                </span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled className="text-xs text-muted-foreground">
                {user?.email}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => { void switchAccountWithGoogle().catch((error) => console.error('Failed to switch account:', error)); }}>
                <LogIn className="h-4 w-4 mr-2" />
                Switch account
              </DropdownMenuItem>
              <DropdownMenuItem onClick={logout} className="text-red-600">
                <LogOut className="h-4 w-4 mr-2" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}
