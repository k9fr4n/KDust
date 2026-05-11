// src/app/api/git-cli/bootstrap/route.ts
//
// Re-run the boot-time gh/glab authentication on demand. Lets the
// operator rotate a token in /settings/secrets and re-authenticate
// the CLIs without a container restart.
//
// Side-effects: writes ~/.config/gh/hosts.yml and
// ~/.config/glab-cli/config.yml. No network egress beyond what
// `gh auth login` / `glab auth login` themselves perform (a single
// API call each to validate the token).

import { NextResponse } from 'next/server';
import { bootstrapGitCliAuth } from '@/lib/git-cli/bootstrap';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const summary = await bootstrapGitCliAuth();
  return NextResponse.json(summary);
}
