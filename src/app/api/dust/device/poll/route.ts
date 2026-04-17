import { NextResponse } from 'next/server';
import { pollDeviceToken } from '@/lib/dust/workos';
export const runtime = 'nodejs';
export async function POST(req: Request) {
  const { deviceCode } = (await req.json()) as { deviceCode: string };
  if (!deviceCode) return NextResponse.json({ error: 'deviceCode required' }, { status: 400 });
  const res = await pollDeviceToken(deviceCode);
  return NextResponse.json(res);
}
