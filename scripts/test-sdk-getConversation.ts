import { getDustClient } from '../src/lib/dust/client';

async function main() {
  const sId = process.argv[2] ?? 'KXqSBGusHL';
  const cli = await getDustClient();
  if (!cli) { console.error('no client'); process.exit(1); }
  const res = await cli.client.getConversation({ conversationId: sId });
  if (res.isErr()) {
    console.error('SDK ERR:');
    console.error(JSON.stringify(res.error, null, 2).slice(0, 4000));
    process.exit(2);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- diagnostic, SDK union type narrowing not worth it
  console.log('SDK OK. conversation has', (res.value as any).content?.length, 'message groups');
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
