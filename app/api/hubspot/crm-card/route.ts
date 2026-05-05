import { NextResponse, after } from 'next/server';
import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';

export const maxDuration = 60;

const CACHE_TTL_MS = 4 * 60 * 60 * 1000;
const MAX_NOTES_CHARS = 4000;
const DEAL_TYPE = '0-3';
const COMPANY_TYPE = '0-2';

const DEAL_PROPERTIES = [
  'dealname', 'dealstage', 'amount', 'closedate', 'pipeline',
  'createdate', 'description', 'deal_source_notes',
  'closed_won_reason', 'closed_lost_reason', 'hubspot_owner_id',
];

const COMPANY_PROPERTIES = [
  'name', 'domain', 'industry', 'description', 'country', 'creator_payout_country',
  'hs_lead_status', 'business_type', 'gtm_revenue_band', 'whop_fit_score',
  'l30_days_gmv', 'l60_days_gmv', 'l90_days_gmv', 'total_gmv',
  'last_30d_new_gmv', 'last_30d_new_gmv_mom', 'last_7d_gmv_wow',
  'current_quarter_gmv', 'prev_quarter_gmv', 'projected_gmv',
  'l30_60_days_gmv', 'yesterdays_gmv',
  'l30d_gmv_on_ad_spend', 'l30d_ad_spend_external', 'total_ads_spend', 'active_deal',
  'l30d_gtv_card_spend', 'l3d_gtv_card_spend', 'l1d_gtv_card_spend', 'total_gtv_card_spend',
  'card_upsell_status', 'cards_upsell_status', 'cards__last_updated_date',
  'has_bnpl_enabled', 'l30d_bnpl_gmv', 'last_30d_bnpl_fee_revenue', 'prev_l30d_bnpl_gmv',
  'payments_status', 'using_whop_payments', 'last_30d_withdrawals',
  'churn_status', 'churn_status_commentary', 'l30_churned_percentage',
  'l7d_soft_churn', 'l3_l1_drop', 'l3_days_no_revenue', 'l30_days_no_revenue', 'missing_l30_gmvs',
  'whopx_qualified', 'whop_x_member', 'whop_u_member',
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

function truncateNotes(notes: string[]): string {
  let total = 0;
  const kept: string[] = [];
  for (const note of notes) {
    if (total + note.length > MAX_NOTES_CHARS) {
      const remaining = MAX_NOTES_CHARS - total;
      if (remaining > 100) kept.push(note.slice(0, remaining) + '...');
      break;
    }
    kept.push(note);
    total += note.length;
  }
  return kept.length > 0
    ? `\n\nNOTES:\n${kept.map((n, i) => `[${i + 1}] ${n}`).join('\n\n')}`
    : '';
}

function buildPrompt(isDeal: boolean, properties: Record<string, string>, notes: string[]): string {
  const propsText = Object.entries(properties)
    .filter(([, v]) => v && v !== 'null' && v !== '')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

  const notesText = truncateNotes(notes);

  if (isDeal) {
    return `Whop sales analyst. Review this deal. Return raw JSON, no markdown, no code fences.

DATA:
${propsText}${notesText}

JSON format:
{"summary":"One sentence: deal status + key thing to know.","keyPoints":["Stage & value","Source & fit","Win/loss reason if any","Risk or blocker","Timeline — moving or stalled"],"nextStep":"Single most important action."}

Rules: One punchy line per keyPoint with label. Skip if no data. Be direct.`;
  }

  return `Whop sales analyst. Whop = creator monetization platform (memberships, courses, communities, payments, BNPL, Whop Cards, Whop Ads, 7% APY treasury, Whop for Platforms).

UPSELLS — flag if not active:
- BNPL (10 providers): USA=AfterPay/Klarna/Splitit/Sezzle/ZipPay/ClarityPay/Climb. EU=Klarna/Scalapay/SeQura. UAE/Saudi=Tamara. UK=AfterPay/Klarna. If off + country supports it → upsell.
- Whop Ads: If l30d_gmv_on_ad_spend is low/zero → growth opportunity.
- Whop Cards (Rain.xyz): Biz spend cards. l30d_gtv_card_spend=0 or card_upsell_status not started → flag.
- Treasury: 7% APY via Veda. Not using it → missing yield.
- Platforms: If marketplace/agency/platform business_type → Whop for Platforms fit (invite-only).
- WhopX: whopx_qualified=true + whop_x_member=false → flag.
- Affiliates: Not set up → call out.
- Payments: using_whop_payments=false or payments_status≠active → major gap.

CHURN ALERTS: l3_days_no_revenue>0=urgent. l7d_soft_churn set=early signal. l30_churned_percentage>20%=high. churn_status≠healthy=flag. GMV L30<L60<L90=downtrend.

ADS DIAGNOSIS (field: active_deal):
Stages: Prospect→Outreached→Engagement→Demo Call Booked→Demo Meeting Held→Assets Shared→Spending→Campaign Paused.
STALE RULE: >2 days since last contact at any stage except Prospect/Spending/Campaign Paused → stale=true.
Notes contain Granola call summaries + chat threads. Use them for: last contact date, verbatim customer quotes on blockers, action items, named contacts blocking progress.
Per stage: Prospect=why no outreach (AM bandwidth? other issue?). Outreached=days+channel+response. Engagement=what blocks booking. Demo Booked=when+who. Demo Held=open action items. Assets Shared=specific blocker (access/tech/ghosting), escalate if >7d. Spending=gap vs 50% of L30 GMV benchmark, specific reason from notes, flag if >14d no contact. Campaign Paused=specific pause reason, re-engagement signals.
Be specific. Name people. Quote customers. Call out AM-side failures plainly.

CARDS DIAGNOSIS (field: card_upsell_status):
From notes surface: business expenses/use case, existing card product (Ramp/Brex/etc), ad spend on cards opportunity, cash back sensitivity, cashflow/payout pain. Payout issues → cards upsell.
Onboarding: stage, days stuck (>7d=flag), KYB issues (name specific blocker).
Retention: l30d vs l3d vs l1d card spend trend. Dropped → why from notes. >14d no contact → flag.

DATA:
${propsText}${notesText}

Return raw JSON only. No markdown. No code fences. No explanation outside the JSON.
{
  "summary": "One sentence: who they are, GMV tier, health.",
  "keyPoints": [
    "GMV: L30/L60/L90 trend with % change",
    "Churn: status + L30%/L7D/L3→L1 flags",
    "BNPL: on/off, country-specific providers if off",
    "Cards: L30D spend, upsell status",
    "Payments: status, balance, withdrawals",
    "Upsells: WhopX/Treasury/Platforms/affiliates",
    "Risk: no-revenue days, missing GMV, payment issues"
  ],
  "adsSection": {
    "stage": "active_deal stage",
    "daysInStage": 0,
    "daysSinceLastContact": 0,
    "stale": false,
    "diagnosis": "Why not fully on ads. Quote notes. Include numbers.",
    "blocker": "Single specific blocker.",
    "nextStep": "Single ads action."
  },
  "cardsSection": {
    "stage": "card_upsell_status stage",
    "spendL30": 0,
    "spendL3": 0,
    "spendL1": 0,
    "spendTrend": "up/flat/down",
    "existingCardProduct": "current card or null",
    "useCase": "what they'd use cards for",
    "cashBackSensitivity": "High/Medium/Low/Unknown",
    "cashflowPain": "payout/cashflow friction or null",
    "kybIssue": "specific KYB blocker or null",
    "daysInOnboarding": 0,
    "diagnosis": "Cards journey + key blocker/opportunity.",
    "nextStep": "Single cards action."
  },
  "nextStep": "Single most important action across entire account."
}

Rules: One punchy line per keyPoint. Label in caps. Skip if no data. "Clean." if healthy. Use specific numbers.`;
}

function parseAIResponse(text: string): Record<string, unknown> | null {
  const stripped = text.replace(/^[^{]*/, '').replace(/[^}]*$/, '').trim();
  try {
    return JSON.parse(stripped);
  } catch {}
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {}
  }
  return null;
}

async function generateAndCache(objectName: string, recordId: string, isDeal: boolean) {
  const properties = isDeal ? DEAL_PROPERTIES : COMPANY_PROPERTIES;

  const [recordRes, notes] = await Promise.all([
    hsRequest('GET', `/crm/v3/objects/${objectName}/${recordId}?properties=${properties.join(',')}`),
    fetchRecentNotes(objectName, recordId),
  ]);

  if (!recordRes.ok) return null;

  const record = await recordRes.json();
  const prompt = buildPrompt(isDeal, record.properties ?? {}, notes);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { text } = await generateText({
        model: anthropic('claude-haiku-4-5-20251001'),
        prompt,
        maxTokens: 2048,
      });

      const result = parseAIResponse(text);
      if (result) {
        await hsRequest('PATCH', `/crm/v3/objects/${objectName}/${recordId}`, {
          properties: {
            pulse_summary_json: JSON.stringify(result),
            pulse_summary_updated_at: new Date().toISOString(),
          },
        });
        return result;
      }
    } catch {}
  }

  return null;
}

function isValidCache(json: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(json);
    if (!parsed.summary || parsed.summary.includes('"keyPoints"') || parsed.summary.includes('```')) {
      return null;
    }
    if (Array.isArray(parsed.keyPoints) && parsed.keyPoints.length === 0) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const recordId = searchParams.get('recordId');
  const objectType = searchParams.get('objectType');
  const refresh = searchParams.get('refresh');

  if (!recordId || !objectType) {
    return NextResponse.json({ error: 'Missing recordId or objectType' }, { status: 400 });
  }

  const isDeal = objectType === DEAL_TYPE;
  const isCompany = objectType === COMPANY_TYPE;

  if (!isDeal && !isCompany) {
    return NextResponse.json({ error: 'Unsupported object type' }, { status: 400 });
  }

  const objectName = isDeal ? 'deals' : 'companies';
  const cacheProps = 'pulse_summary_json,pulse_summary_updated_at';

  const cacheRes = await hsRequest('GET', `/crm/v3/objects/${objectName}/${recordId}?properties=${cacheProps}`);
  if (!cacheRes.ok) {
    return NextResponse.json({ error: 'Failed to fetch record from HubSpot' }, { status: 502 });
  }

  const cacheRecord = await cacheRes.json();
  const cachedJson = cacheRecord.properties?.pulse_summary_json;
  const cachedAt = cacheRecord.properties?.pulse_summary_updated_at;

  const isFresh = cachedAt && cachedJson
    && (Date.now() - new Date(cachedAt).getTime()) < CACHE_TTL_MS
    && refresh !== 'true';

  if (isFresh) {
    const cached = isValidCache(cachedJson);
    if (cached) return NextResponse.json(cached);
  }

  if (cachedJson && !refresh) {
    const cached = isValidCache(cachedJson);
    if (cached) {
      after(async () => {
        await generateAndCache(objectName, recordId, isDeal);
      });
      return NextResponse.json(cached);
    }
  }

  after(async () => {
    await generateAndCache(objectName, recordId, isDeal);
  });

  return NextResponse.json({
    summary: 'Generating Pulse summary — hit Retry in ~15 seconds.',
    keyPoints: [],
    nextStep: 'Retry to load the full analysis.',
  });
}
