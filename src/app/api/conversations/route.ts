import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { createDustConversation } from '@/lib/dust/chat';
import { getCurrentProjectName } from '@/lib/current-project';

export const runtime = 'nodejs';

export async function GET() {
  const project = await getCurrentProjectName();
  const conversations = await db.conversation.findMany({
    where: project ? { projectName: project } : undefined,
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      title: true,
      agentName: true,
      agentSId: true,
      updatedAt: true,
      projectName: true,
    },
    take: 100,
  });
  return NextResponse.json({ conversations });
}

const CreateSchema = z.object({
  agentSId: z.string().min(1),
  agentName: z.string().optional(),
  content: z.string().min(1),
  title: z.string().optional(),
  mcpServerIds: z.array(z.string()).optional(),
});

export async function POST(req: Request) {
  const parsed = CreateSchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.format() }, { status: 400 });

  const project = await getCurrentProjectName();
  const { agentSId, agentName, content, title, mcpServerIds } = parsed.data;

  const dust = await createDustConversation(agentSId, content, title, mcpServerIds);

  const derivedTitle = title && title.trim().length > 0
    ? title
    : content.slice(0, 80).replace(/\s+/g, ' ');

  const conv = await db.conversation.create({
    data: {
      dustConversationSId: dust.dustConversationSId,
      agentSId,
      agentName: agentName ?? null,
      title: derivedTitle,
      projectName: project,
      messages: {
        create: [{ role: 'user', content }],
      },
    },
  });

  return NextResponse.json({
    id: conv.id,
    dustConversationSId: dust.dustConversationSId,
    userMessageSId: dust.userMessageSId,
  });
}
