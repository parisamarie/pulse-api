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
  'name', 'domain', 'industry', 'description', 'country', 'creator_payout_country',
  'hs_lead_status', 'churn_status', 'churn_status_commentary',
  'l30_days_gmv', 'l60_days_gmv', 'l90_days_gmv', 'total_gmv',
  'l30d_gmv_on_ad_spend', 'l30d_ad_spend_external', 'total_ads_spend', 'active_deal',
  'l30d_gtv_card_spend', 'total_gtv_card_spend', 'card_upsell_status', 'cards_upsell_status',
  'has_bnpl_enabled', 'l30d_bnpl_gmv', 'last_30d_bnpl_fee_revenue',
  'payments_status', 'using_whop_payments', 'last_30d_withdrawals',
  'l30_churned_percentage', 'l7d_soft_churn', 'l3_l1_drop',
  'l3_days_no_revenue', 'l30_days_no_revenue', 'missing_l30_gmvs',
  'last_7d_gmv_wow', 'last_30d_new_gmv', 'last_30d_new_gmv_mom',
  'current_quarter_gmv', 'prev_quarter_gmv', 'projected_gmv',
  'gtm_revenue_band', 'whop_fit_score', 'whopx_qualified', 'whop_x_member', 'whop_u_member',
  'annualrevenue', 'numberofemployees', 'hubspot_owner_id',
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

  const companyInstructions = `You are a Whop sales analyst. Whop is a creator monetization platform. Review this company and give a sharp, punchy briefing a sales rep can act on immediately.

COMPANY DATA:
${propsText}${notesText}

Respond with valid JSON in exactly this format:
{
  "summary": "One sentence: who they are and their current health on Whop.",
  "keyPoints": [
    "BNPL: on or off — if off, flag as upsell opportunity",
    "Cards: L30D card spend and whether Cards upsell has been started",
    "Ad Spend: L30D GMV on ad spend and ads upsell status",
    "Churn: churn status, L30 churned %, L7D soft churn, L3→L1 drop — flag anything alarming",
    "GMV trend: L30/L60/L90 GMV comparison — growing, flat, or declining",
    "Country: flag if country limits available features (BNPL, payouts, cards) or creates a risk",
    "Risk: any negative balance, missing GMV, no revenue days, or payments issues"
  ],
  "nextStep": "Single most important action — be specific and direct."
}

Rules:
- Each keyPoint is one short punchy line. Lead with the label (e.g. "BNPL:", "Churn:").
- Only include a keyPoint if there is actual data or a clear flag. Skip if no data.
- Never pad with generic advice. If something looks good, say so in one word ("Clean").
- Flag risks bluntly. Flag upsell gaps directly.
- Country context: if payout country limits BNPL or card features, call it out.`;

  const dealInstructions = `You are a Whop sales analyst. Review this deal and give a sharp, punchy briefing a sales rep can act on immediately.

DEAL DATA:
${propsText}${notesText}

Respond with valid JSON in exactly this format:
{
  "summary": "One sentence: deal status and the key thing to know.",
  "keyPoints": [
    "Stage & value — where it is and what it's worth",
    "Source — how it came in and any context on fit",
    "Win/loss signal — reason won or lost if available",
    "Risk or blocker — anything that looks off",
    "Timeline — is it moving or stalled"
  ],
  "nextStep": "Single most important action — be specific and direct."
}

Rules:
- Each keyPoint is one short punchy line. Lead with a label.
- Only include a keyPoint if there is actual data. Skip if no data.
- Never pad. Be direct.`;

  return isDeal ? dealInstructions : companyInstructions;
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
