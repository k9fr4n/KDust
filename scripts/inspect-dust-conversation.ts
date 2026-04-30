/**
 * READ-ONLY diagnostic — fetch the raw conversation JSON from the
 * Dust API, bypassing @dust-tt/client's Zod schema (which currently
 * rejects valid responses with `unexpected_response_format`).
 *
 * Usage:
 *   npx tsx scripts/inspect-dust-conversation.ts <conversationSId> [messageIndex]
 *
 * Author: Franck (2026-04-30) — disposable diagnostic, not for prod.
 */
import { getValidAccessToken } from '../src/lib/dust/client';
import { loadTokens } from '../src/lib/dust/tokens';
import { resolveDustUrl } from '../src/lib/dust/region';

async function main() {
  const sId = process.argv[2];
  const targetIdx = process.argv[3] ? Number(process.argv[3]) : 111;
  if (!sId) {
    console.error('usage: tsx scripts/inspect-dust-conversation.ts <conversationSId> [messageIndex]');
    process.exit(1);
  }

  const tokens = await loadTokens();
  if (!tokens?.workspaceId) throw new Error('No DustSession in DB');
  const accessToken = await getValidAccessToken();
  if (!accessToken) throw new Error('No valid access token');

  const baseUrl = await resolveDustUrl(tokens.region);
  const url = `${baseUrl}/api/v1/w/${tokens.workspaceId}/assistant/conversations/${sId}`;
  console.log('GET', url);

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    console.error('HTTP', res.status, await res.text());
    process.exit(2);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw API payload, intentionally untyped
  const json: any = await res.json();
  const content = json?.conversation?.content;
  console.log('content.length =', content?.length);

  const group = content?.[targetIdx];
  const msg = Array.isArray(group) ? group[0] : group;
  console.log(`\n=== content[${targetIdx}][0] ===`);
  console.log('  type           :', msg?.type);
  console.log('  sId            :', msg?.sId);
  console.log('  content (preview):', String(msg?.content ?? '').slice(0, 200));
  console.log('  actions count  :', msg?.actions?.length);

  // Global scan: find ANY action whose output[0] is a string (the
  // shape that breaks @dust-tt/client's Zod schema).
  console.log('\n\n========== GLOBAL SCAN: hunting string output[0] ==========');
  let badCount = 0;
  for (let g = 0; g < (content?.length ?? 0); g++) {
    const grp = content[g];
    if (!Array.isArray(grp)) continue;
    for (let m = 0; m < grp.length; m++) {
      const mm = grp[m];
      if (mm?.type !== 'agent_message') continue;
      const acts = mm?.actions ?? [];
      for (let i = 0; i < acts.length; i++) {
        const out = acts[i]?.output;
        if (Array.isArray(out)) {
          for (let k = 0; k < out.length; k++) {
            if (typeof out[k] === 'string') {
              badCount++;
              console.log(`  BAD: content[${g}][${m}].actions[${i}].output[${k}]  fn=${acts[i].functionCallName}  string="${String(out[k]).slice(0, 120)}..."`);
            } else if (out[k] !== null && typeof out[k] === 'object' && !('type' in out[k])) {
              console.log(`  WEIRD: content[${g}][${m}].actions[${i}].output[${k}]  fn=${acts[i].functionCallName}  no-type-key keys=${Object.keys(out[k])}`);
            }
          }
        } else if (typeof out === 'string') {
          badCount++;
          console.log(`  BAD: content[${g}][${m}].actions[${i}].output (whole)  fn=${acts[i].functionCallName}  string="${String(out).slice(0, 120)}..."`);
        }
      }
    }
  }
  console.log(`\n========== Total bad string-shaped outputs: ${badCount} ==========`);

  const actions = msg?.actions ?? [];
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    const out = a?.output;
    const isArr = Array.isArray(out);
    const first = isArr ? out[0] : out;
    const t = typeof first;
    const flag = t === 'string' ? '  <-- STRING' : '';
    console.log(`\n  --- action[${i}] ${flag}`);
    console.log('    functionCallName :', a?.functionCallName);
    console.log('    output isArray   :', isArr, '  length:', isArr ? out.length : 'n/a');
    console.log('    output[0] type   :', t);
    if (t === 'string') {
      console.log('    output[0] (first 400 chars):', JSON.stringify(first).slice(0, 400));
    } else if (t === 'object' && first) {
      console.log('    output[0] keys   :', Object.keys(first));
      console.log('    output[0] preview:', JSON.stringify(first).slice(0, 400));
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
