import { NextResponse } from 'next/server';
import { pollDeviceToken } from '@/lib/dust/workos';
import { badRequest } from "@/lib/api/responses";
export const runtime = 'nodejs';
export async function POST(req: Request) {
  const { deviceCode } = (await req.json()) as { deviceCode: string };
  if (!deviceCode) return badRequest('deviceCode required');
  const res = await pollDeviceToken(deviceCode);
  return NextResponse.json(res);
}
