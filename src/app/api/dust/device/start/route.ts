import { NextResponse } from 'next/server';
import { startDeviceFlow } from '@/lib/dust/workos';
import { serverError } from "@/lib/api/responses";
export const runtime = 'nodejs';
export async function POST() {
  try {
    const data = await startDeviceFlow();
    return NextResponse.json(data);
  } catch (err) {
    return serverError((err as Error).message);
  }
}
