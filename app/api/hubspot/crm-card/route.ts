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
  // Identity
  'name', 'domain', 'industry', 'description', 'country', 'creator_payout_country',
  'hs_lead_status', 'business_type', 'gtm_revenue_band', 'whop_fit_score',
  // GMV & Revenue
  'l30_days_gmv', 'l60_days_gmv', 'l90_days_gmv', 'total_gmv',
  'last_30d_new_gmv', 'last_30d_new_gmv_mom', 'last_7d_gmv_wow',
  'current_quarter_gmv', 'prev_quarter_gmv', 'projected_gmv',
  'l30_60_days_gmv', 'yesterdays_gmv',
  // Ad Spend
  'l30d_gmv_on_ad_spend', 'l30d_ad_spend_external', 'total_ads_spend', 'active_deal',
  // Cards
  'l30d_gtv_card_spend', 'total_gtv_card_spend', 'card_upsell_status', 'cards_upsell_status',
  // BNPL
  'has_bnpl_enabled', 'l30d_bnpl_gmv', 'last_30d_bnpl_fee_revenue', 'prev_l30d_bnpl_gmv',
  // Payments & Balance
  'payments_status', 'using_whop_payments', 'last_30d_withdrawals',
  // Churn & Health
  'churn_status', 'churn_status_commentary', 'l30_churned_percentage',
  'l7d_soft_churn', 'l3_l1_drop', 'l3_days_no_revenue', 'l30_days_no_revenue', 'missing_l30_gmvs',
  // WhopX / Tiers
  'whopx_qualified', 'whop_x_member', 'whop_u_member',
  // Other
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

  const companyInstructions = `You are a Whop sales analyst. Whop is an all-in-one creator monetization platform — memberships, courses, communities, events, affiliates, and a full payments stack (multi-PSP routing, BNPL, Whop Cards, 7% APY treasury, Whop for Platforms).

CONTEXT ON WHOP'S KEY UPSELLS & VALUE PROPS:
- BNPL: Whop offers 10 BNPL providers. Enabling BNPL increases checkout conversion, especially for high-ticket offers. Availability depends on country: USA (AfterPay, Klarna, Splitit, Sezzle, ZipPay, ClarityPay, Climb), EU (Klarna, Scalapay, SeQura), UAE/Saudi (Tamara), Spain (SeQura), Italy/France/Spain/Portugal (Scalapay). If BNPL is off and country supports it, this is an immediate upsell.
- Whop Ads: Creators can run ads on Whop's platform to drive discovery. If l30d_gmv_on_ad_spend or ad_spend is low/zero, they're leaving growth on the table.
- Whop Cards (via Rain.xyz): Business spend cards. If l30d_gtv_card_spend is zero or card_upsell_status shows not started, flag it.
- Whop Finance / Treasury: 7% APY on balances via Veda staking. If they're not using it, they're missing yield on their Whop balance.
- Whop for Platforms: If business type looks like a marketplace, agency, or platform operator, Whop for Platforms (like Stripe Connect) is a fit — invite-only, contact sales@whop.com.
- WhopX: Premium tier for top creators. If whopx_qualified is true but whop_x_member is false, flag it.
- Affiliates: Native affiliate/rev-share program. If not set up, call it out.
- Payments: If using_whop_payments is false or payments_status is not active, that's a major gap.

COUNTRY-SPECIFIC CONTEXT:
- UAE/Saudi Arabia: Tamara BNPL available (Sharia-compliant, no fees). Strong growth market.
- EU (Italy, France, Spain, Portugal): Scalapay, SeQura, Klarna available.
- UK: AfterPay (ClearPay), Klarna available.
- USA: Full suite — all 10 BNPL options potentially available.
- Outside these regions: Limited BNPL. Flag if this is blocking conversion.

CHURN RISK THRESHOLDS:
- l3_days_no_revenue > 0: urgent — recent revenue gap
- l7d_soft_churn is set: early churn signal, needs immediate outreach
- l30_churned_percentage > 20%: high churn, retention play needed
- l3_l1_drop is negative: membership shrinking
- churn_status is anything other than healthy/active: flag immediately
- GMV declining L30 vs L60 vs L90: downtrend, investigate

COMPANY DATA:
${propsText}${notesText}

Respond with valid JSON in exactly this format:
{
  "summary": "One sentence: who they are, their GMV tier, and current health on Whop.",
  "keyPoints": [
    "GMV: L30/L60/L90 trend — growing, flat, or declining with % change if possible",
    "Churn: status, L30 churned %, L7D soft churn, L3→L1 drop — flag anything alarming",
    "BNPL: on/off — if off, which providers are available for their country (be specific)",
    "Ads: L30D GMV on ad spend and ads upsell status — opportunity or already active",
    "Cards: L30D card spend — using it or not, upsell status",
    "Payments: using Whop payments, any balance issues, withdrawals",
    "Upsells: WhopX qualification, Whop Finance/Treasury, Platforms API fit, affiliates",
    "Risk: any red flags — no revenue days, missing GMV, negative balance, payment issues, country blocks"
  ],
  "nextStep": "Single most important action right now — be specific (e.g. 'Enable Klarna BNPL — EU-based, currently $0 BNPL GMV' or 'Urgent: 3 days no revenue, soft churn signal — call today')."
}

Rules:
- Each keyPoint is one punchy line. Lead with the label in caps.
- Only include a keyPoint if there is actual data or a clear flag. Skip lines with no data.
- If something is clean and healthy, one word: "Clean."
- Never pad. Surface what matters. Flag risks bluntly. Call out upsells directly.
- Be specific with numbers when available (e.g. "$12k L30 GMV, down 18% vs L60").`;

  const dealInstructions = `You are a Whop sales analyst. Review this deal and give a sharp, punchy briefing a sales rep can act on immediately.

DEAL DATA:
${propsText}${notesText}

Respond with valid JSON in exactly this format:
{
  "summary": "One sentence: deal status and the single most important thing to know.",
  "keyPoints": [
    "Stage & value — where it is and what it's worth",
    "Source — how it came in and fit signal",
    "Win/loss signal — reason won or lost if available",
    "Risk or blocker — anything that looks off",
    "Timeline — moving or stalled"
  ],
  "nextStep": "Single most important action — specific and direct."
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
