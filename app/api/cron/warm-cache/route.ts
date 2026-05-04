import { NextResponse } from 'next/server';
import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';

export const maxDuration = 300;

const CACHE_TTL_MS = 4 * 60 * 60 * 1000;
const BATCH_SIZE = 10;

async function hsRequest(method: string, path: string, body?: unknown) {
  return fetch(`https://api.hubapi.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.HUBSPOT_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function getCompaniesNeedingCache(): Promise<string[]> {
  const ids: string[] = [];
  let after: string | undefined;

  while (ids.length < 100) {
    const body: Record<string, unknown> = {
      filterGroups: [{
        filters: [{
          propertyName: 'hubspot_owner_id',
          operator: 'HAS_PROPERTY',
        }],
      }],
      properties: ['pulse_summary_updated_at'],
      sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
      limit: 100,
    };
    if (after) body.after = after;

    const res = await hsRequest('POST', '/crm/v3/objects/companies/search', body);
    if (!res.ok) break;
    const data = await res.json();

    for (const record of data.results ?? []) {
      const cachedAt = record.properties?.pulse_summary_updated_at;
      if (!cachedAt || (Date.now() - new Date(cachedAt).getTime()) > CACHE_TTL_MS) {
        ids.push(record.id);
      }
    }

    if (!data.paging?.next?.after) break;
    after = data.paging.next.after;
  }

  return ids;
}

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const ids = await getCompaniesNeedingCache();
  let warmed = 0;

  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (id) => {
        const res = await fetch(
          `https://pulse-api.vercel.app/api/hubspot/crm-card?recordId=${id}&objectType=0-2&refresh=true`,
        );
        return res.ok;
      }),
    );
    warmed += results.filter((r) => r.status === 'fulfilled' && r.value).length;
  }

  return NextResponse.json({ warmed, total: ids.length });
}
