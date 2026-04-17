import { NextResponse } from 'next/server';
import { startDeviceFlow } from '@/lib/dust/workos';
export const runtime = 'nodejs';
export async function POST() {
  try {
    const data = await startDeviceFlow();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
