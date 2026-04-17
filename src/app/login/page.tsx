'use client';
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/Button';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setErr(null);
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    setLoading(false);
    if (!res.ok) {
      setErr((await res.json()).error ?? 'error');
      return;
    }
    router.replace(params.get('from') ?? '/');
  };

  return (
    <form onSubmit={submit} className="w-80 space-y-3 p-6 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
      <h1 className="text-xl font-semibold">KDust — Login</h1>
      <input
        type="password"
        placeholder="mot de passe"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-2"
        autoFocus
      />
      {err && <p className="text-sm text-red-500">{err}</p>}
      <Button type="submit" disabled={loading} className="w-full">
        {loading ? 'Connexion...' : 'Se connecter'}
      </Button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <Suspense fallback={<div>Chargement...</div>}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
