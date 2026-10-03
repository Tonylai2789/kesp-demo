import { useState, type FormEvent } from 'react';
import { LogIn } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/contexts/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/** Dedicated entry for the fixed accounts in the isolated demo. */
export function LoginPage() {
  const { signInWithGoogle, signInWithPassword, error, loading } = useAuth();
  const { t } = useTranslation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const handlePasswordLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loading) return;
    setPassword('');
    await signInWithPassword(username, password);
  };

  return <main className="min-h-screen flex items-center justify-center bg-background px-6 py-8">
    <div className="w-full max-w-sm space-y-6">
      <h1 className="text-3xl font-semibold">KESP Demo</h1>
      <p className="text-muted-foreground">{t('demo.loginSubtitle')}</p>
      {error && <p id="login-error" role="alert" className="text-sm text-red-600 break-words">{t('demo.loginFailed')}</p>}
      <form onSubmit={handlePasswordLogin} aria-label={t('demo.supervisorLogin')} aria-busy={loading} aria-describedby={error ? 'login-error' : undefined}>
        <fieldset disabled={loading} className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="demo-username" className="text-sm font-medium">{t('demo.username')}</label>
            <Input id="demo-username" name="username" type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} required value={username} onChange={(event) => setUsername(event.target.value)} />
          </div>
          <div className="space-y-2">
            <label htmlFor="demo-password" className="text-sm font-medium">{t('demo.password')}</label>
            <Input id="demo-password" name="password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
          </div>
          <Button type="submit" disabled={loading} className="w-full"><LogIn size={18} aria-hidden="true" />{t(loading ? 'common.loading' : 'demo.supervisorLogin')}</Button>
        </fieldset>
      </form>
      <Button type="button" variant="outline" disabled={loading} onClick={signInWithGoogle} className="w-full"><LogIn size={18} aria-hidden="true" />{t(loading ? 'common.loading' : 'demo.googleLogin')}</Button>
    </div>
  </main>;
}
