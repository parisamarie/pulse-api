import { NextResponse } from 'next/server';
import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';

const DEAL_TYPE = '0-3';
const COMPANY_TYPE = '0-2';

const DEAL_PROPERTIES = [
  'dealname', 'dealstage', 'amount', 'closedate', 'pipeline',
  'createdate', 'description', 'deal_source_notes',
  'closed_won_reason', 'closed_lost_reason', 'hubspot_owner_id',
];

const COMPANY_PROPERTIES = [
  'name', 'domain', 'industry', 'description',
  'annualrevenue', 'numberofemployees', 'city', 'country', 'hs_lead_status',
];

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

async function fetchRecentNotes(objectName: string, recordId: string): Promise<string[]> {
  try {
    const assocRes = await hsRequest('GET', `/crm/v3/objects/${objectName}/${recordId}/associations/notes`);
    if (!assocRes.ok) return [];
    const assocData = await assocRes.json();
    const noteIds: string[] = (assocData.results ?? []).slice(0, 8).map((r: { id: string }) => r.id);
    if (noteIds.length === 0) return [];

    const batchRes = await hsRequest('POST', '/crm/v3/objects/notes/batch/read', {
      properties: ['hs_note_body', 'hs_timestamp'],
      inputs: noteIds.map((id) => ({ id })),
    });
    if (!batchRes.ok) return [];
    const batchData = await batchRes.json();

    return (batchData.results ?? [])
      .sort(
        (a: { properties: { hs_timestamp: string } }, b: { properties: { hs_timestamp: string } }) =>
          new Date(b.properties.hs_timestamp).getTime() - new Date(a.properties.hs_timestamp).getTime(),
      )
      .map((n: { properties: { hs_note_body: string } }) => n.properties.hs_note_body)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function buildPrompt(isDeal: boolean, properties: Record<string, string>, notes: string[]): string {
  const recordType = isDeal ? 'deal' : 'company';

  const propsText = Object.entries(properties)
    .filter(([, v]) => v && v !== 'null' && v !== '')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

  const notesText =
    notes.length > 0
      ? `\n\nRECENT NOTES:\n${notes.map((n, i) => `[${i + 1}] ${n}`).join('\n\n')}`
      : '';

  return `You are a sales analyst for Whop, a creator monetization platform. Review this ${recordType} and provide a concise, honest analysis.

${recordType.toUpperCase()} DATA:
${propsText}${notesText}

Respond with valid JSON in exactly this format:
{
  "summary": "2-3 sentence overview of the current state",
  "keyPoints": ["insight 1", "insight 2", "insight 3"],
  "nextStep": "The single most important action to take right now"
}

Be specific and direct. Focus on what matters most for ${isDeal ? 'closing or advancing this deal' : 'growing or converting this account'}.`;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const recordId = searchParams.get('recordId');
  const objectType = searchParams.get('objectType');

  if (!recordId || !objectType) {
    return NextResponse.json({ error: 'Missing recordId or objectType' }, { status: 400 });
  }

  const isDeal = objectType === DEAL_TYPE;
  const isCompany = objectType === COMPANY_TYPE;

  if (!isDeal && !isCompany) {
    return NextResponse.json({ error: 'Unsupported object type' }, { status: 400 });
  }

  const objectName = isDeal ? 'deals' : 'companies';
  const properties = isDeal ? DEAL_PROPERTIES : COMPANY_PROPERTIES;

  const recordRes = await hsRequest(
    'GET',
    `/crm/v3/objects/${objectName}/${recordId}?properties=${properties.join(',')}`,
  );

  if (!recordRes.ok) {
    return NextResponse.json({ error: 'Failed to fetch record from HubSpot' }, { status: 502 });
  }

  const record = await recordRes.json();
  const notes = await fetchRecentNotes(objectName, recordId);
  const prompt = buildPrompt(isDeal, record.properties ?? {}, notes);

  const { text } = await generateText({
    model: anthropic('claude-sonnet-4-6'),
    prompt,
  });

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return NextResponse.json({ summary: text, keyPoints: [], nextStep: '' });
  }

  try {
    const result = JSON.parse(jsonMatch[0]);
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ summary: text, keyPoints: [], nextStep: '' });
  }
}
