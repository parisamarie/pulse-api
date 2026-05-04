import { NextResponse } from 'next/server';
import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';

export const maxDuration = 60;

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
  'l30d_gtv_card_spend', 'l3d_gtv_card_spend', 'l1d_gtv_card_spend', 'total_gtv_card_spend',
  'card_upsell_status', 'cards_upsell_status', 'cards__last_updated_date',
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
BNPL: Whop offers 10 BNPL providers. Enabling BNPL increases checkout conversion, especially for high-ticket offers. Availability depends on country: USA (AfterPay, Klarna, Splitit, Sezzle, ZipPay, ClarityPay, Climb), EU (Klarna, Scalapay, SeQura), UAE/Saudi (Tamara), Spain (SeQura), Italy/France/Spain/Portugal (Scalapay). If BNPL is off and country supports it, this is an immediate upsell.
Whop Ads: Creators can run ads on Whop's platform to drive discovery. If l30d_gmv_on_ad_spend or ad_spend is low/zero, they're leaving growth on the table.
Whop Cards (via Rain.xyz): Business spend cards. If l30d_gtv_card_spend is zero or card_upsell_status shows not started, flag it.
Whop Finance / Treasury: 7% APY on balances via Veda staking. If they're not using it, they're missing yield on their Whop balance.
Whop for Platforms: If business type looks like a marketplace, agency, or platform operator, Whop for Platforms (like Stripe Connect) is a fit — invite-only, contact sales@whop.com.
WhopX: Premium tier for top creators. If whopx_qualified is true but whop_x_member is false, flag it.
Affiliates: Native affiliate/rev-share program. If not set up, call it out.
Payments: If using_whop_payments is false or payments_status is not active, that's a major gap.

COUNTRY-SPECIFIC CONTEXT:
UAE/Saudi Arabia: Tamara BNPL available (Sharia-compliant, no fees). Strong growth market.
EU (Italy, France, Spain, Portugal): Scalapay, SeQura, Klarna available.
UK: AfterPay (ClearPay), Klarna available.
USA: Full suite — all 10 BNPL options potentially available.
Outside these regions: Limited BNPL. Flag if this is blocking conversion.

CHURN RISK THRESHOLDS:
l3_days_no_revenue > 0: urgent — recent revenue gap
l7d_soft_churn is set: early churn signal, needs immediate outreach
l30_churned_percentage > 20%: high churn, retention play needed
churn_status is anything other than healthy/active: flag immediately
GMV declining L30 vs L60 vs L90: downtrend, investigate

================================================================
ADS PIPELINE DIAGNOSIS — RUN FOR EVERY COMPANY
================================================================

Every active company has an ads pipeline stage in \`active_deal\`. Stages: Prospect → Outreached → Engagement → Demo Call Booked → Demo Meeting Held → Assets Shared → Spending → Campaign Paused. You must produce a per-company ads diagnosis explaining exactly why they are not fully spending on Whop Ads, based on the stage they're in.

HOW TO READ THE NOTES:
The company notes contain BOTH Granola call summaries (with timestamps and action items) AND text chat threads with the customer. Treat the notes as the source of truth for everything not in structured HubSpot fields:
- Most recent note timestamp = last contact date
- Pull verbatim quotes from customer when they explain a blocker, gate, or objection — they're more useful than paraphrase
- Look for action items / commitments from Granola notes (who agreed to do what, by when)
- Look for sentiment shifts (customer cooling, escalating, going dark)
- If notes reference an internal contact ("waiting on Jennifer," "need approval from CFO") name them in the diagnosis

STALENESS RULE — APPLIES TO EVERY STAGE EXCEPT PROSPECT, SPENDING, AND CAMPAIGN PAUSED:
If days-since-last-contact > 2 days at the current stage, mark stale: true and add "STALE" to the diagnosis line. The 2-day rule is hard. Whop AMs are expected to keep ads deals warm.

STAGE-BY-STAGE LOGIC:

PROSPECT — Not outreached yet.
Default line: "Not outreached about ads yet."
Always scan notes for WHY no outreach has happened. Look for: AM handling another issue (payments problem, churn save, support escalation), customer relationship strain, or genuine bandwidth gap. If you find a reason, surface it.
Examples:
- "Not outreached — AM working through Stripe payout issue first (last note 3d ago)."
- "Not outreached — customer flagged churn risk, AM in retention mode before pitching ads."
- "Not outreached, no reason in notes — AM bandwidth gap."

OUTREACHED — AM reached out, no real response yet.
Surface: days since outreach, channel (DM / email / call attempt), any partial response. Apply staleness rule.
Example: "Outreached via DM 4d ago, no response — STALE. Last customer activity was on a billing thread, not ads."

ENGAGEMENT — Customer responded but no demo booked.
Surface: what's blocking the call. Did they ask to defer? Schedule issue? Going dark mid-thread? Pull the specific reason from notes. Apply staleness rule.
Example: "Engaged 3d ago, customer said 'next week' — AM hasn't sent booking link. STALE."

DEMO CALL BOOKED — Demo on the calendar.
Surface: when the demo is, who attends from customer side, any prep asks from chat lead-up.
Example: "Demo booked Thu 2pm with founder + marketing lead. Customer asked for creative samples in advance."

DEMO MEETING HELD — Demo happened, assets not yet shared.
Surface: open action items from Granola notes — specifically what the customer committed to do. Quote where useful. Apply staleness rule.
Example: "Demo held 5d ago — customer committed to looping in marketing lead for Meta BM access. No follow-through in notes since. STALE."

ASSETS SHARED — Customer in the asset-sharing flow but not spending.
Surface: the actual blocker. Common patterns:
- Internal access blocker ("waiting on Jennifer for Meta BM access")
- Technical handoff issue
- Customer ghosting after partial share
- Asking for something Whop doesn't support
Apply staleness rule. Days-in-stage matters here — if they've been in this stage > 7 days, escalate the language.
Example: "Assets Shared stage 8d — waiting on Jennifer (their CMO) for Meta BM access per Granola call 6d ago. AM hasn't nudged since. STALE."

SPENDING — Live on ads. The diagnosis here is "why aren't they spending more."
Calculate the gap: healthy ad spend benchmark is 50% of L30 GMV. Compare l30d_ad_spend_external to 50% × l30_days_gmv.
- Under 50% → there's room to scale, surface the gap as a $ figure and as a %
- At or above 50% → "Spending at healthy ratio."
Then pull the SPECIFIC reason from notes for why they're not at full volume. Common patterns:
- Self-imposed ramp gate ("$10k/day for one week, then $30k/day if perf holds")
- Performance concern / waiting on ROAS proof
- Competitive comparison (e.g. "6% cash back on ad spend with another platform")
- Budget cycle / cash flow timing
- Seasonality or product launch timing
Don't apply the 2-day staleness rule here — spending customers don't need to be contacted every 2 days, but flag if last contact > 14 days.
Example: "Spending $15k L30 vs $200k L30 GMV (7.5% — should be ~$100k at 50% benchmark). Customer gating at $10k/day pending 1 week of ROAS data per call 4d ago. Scale review due."

CAMPAIGN PAUSED — Whop's "lost" stage for ads.
Surface: the actual reason for the pause from notes. Be specific. Common patterns:
- Performance ("CPMs too high," "ROAS below target")
- Switched to in-house Meta team or competitor
- Budget cycle / cash flow
- Seasonality
- Bad creative / creative fatigue
- Lost faith / bad experience
Also flag re-engagement signals from notes ("open to revisit Q2," "want to retry with new creative").
Example: "Paused 12d ago — customer cited 'CPMs too high vs in-house Meta team' on call. Open to re-engage Q2 per chat thread."

================================================================
CARDS DIAGNOSIS — RUN FOR EVERY COMPANY
================================================================

Every company has a cards pipeline stage in \`card_upsell_status\`. Use notes as the primary source of truth for qualitative signals — what they're spending on, what card product they currently use, cashflow pain points, KYB blockers, and cash back sensitivity.

WHAT TO SURFACE FROM NOTES:
- What are their business expenses and what would they use cards for? (ads, payroll, software, travel, etc.)
- Are they using another card product already? (Ramp, Brex, corporate Amex, etc.) — if so, what's the switching barrier?
- Do they have ad spend that could run on Whop Cards? Flag the opportunity specifically.
- How much do they care about cash back? Any mention of cash back rates from a competitor is a direct attack vector.
- What is their biggest cards pain point? Cashflow issues, delayed payouts, needing float?
- If they have payout issues or withdrawal friction with Whop, flag this as a cards upsell — Whop Cards solves the "I need cash faster" problem.

ONBOARDING & KYB:
- What stage are they in onboarding? Have they applied, been approved, received physical card?
- How long have they been in the current onboarding stage? If > 7 days stuck, flag it.
- Are they experiencing KYB issues? Look for any mention of identity verification, document submission, compliance holds.
- If KYB is a blocker, name the specific issue from notes.

RETENTION (for active card users):
- Are they spending as a proportion of their GMV? Healthy benchmark: card spend should grow alongside GMV.
- Compare l30d_gtv_card_spend vs l3d_gtv_card_spend vs l1d_gtv_card_spend — is spend trending up, flat, or declining?
- If spend dropped week-over-week, pull the specific reason from notes. Common patterns: paused ad campaigns, seasonal slowdown, switched back to old card, cash flow timing.
- Flag if last contact > 14 days for active card users.

================================================================

COMPANY DATA:
${propsText}${notesText}

================================================================

Respond with valid JSON in exactly this format:
{
  "summary": "One sentence: who they are, their GMV tier, and current health on Whop.",
  "keyPoints": [
    "GMV: L30/L60/L90 trend — growing, flat, or declining with % change if possible",
    "Churn: status, L30 churned %, L7D soft churn, L3→L1 drop — flag anything alarming",
    "BNPL: on/off — if off, which providers are available for their country (be specific)",
    "Cards: L30D card spend — using it or not, upsell status",
    "Payments: using Whop payments, any balance issues, withdrawals",
    "Upsells: WhopX qualification, Whop Finance/Treasury, Platforms API fit, affiliates",
    "Risk: any red flags — no revenue days, missing GMV, negative balance, payment issues, country blocks"
  ],
  "adsSection": {
    "stage": "Current active_deal stage name",
    "daysInStage": 0,
    "daysSinceLastContact": 0,
    "stale": false,
    "diagnosis": "One punchy line explaining exactly why they are not fully on ads at this stage. Quote from notes where useful. Include numbers when relevant (GMV gap for Spending, days stuck for Assets Shared, etc.).",
    "blocker": "The single specific blocker — internal access, ramp gate, competitive comparison, performance concern, AM bandwidth, etc.",
    "nextStep": "The single most important ads-specific action right now."
  },
  "cardsSection": {
    "stage": "Current card_upsell_status stage name",
    "spendL30": 0,
    "spendL3": 0,
    "spendL1": 0,
    "spendTrend": "up / flat / down",
    "existingCardProduct": "What card product they currently use, or null if none",
    "useCase": "What they would use Whop Cards for based on notes — ad spend, payroll, software, etc.",
    "cashBackSensitivity": "High / Medium / Low / Unknown — based on any mention in notes",
    "cashflowPain": "Describe any cashflow or payout friction that makes cards a fit, or null",
    "kybIssue": "Specific KYB blocker from notes, or null",
    "daysInOnboarding": 0,
    "diagnosis": "One punchy line on where they are in the cards journey and the key blocker or opportunity.",
    "nextStep": "The single most important cards-specific action right now."
  },
  "nextStep": "Single most important action across the whole account right now — be specific (e.g. 'Enable Klarna BNPL — EU-based, currently $0 BNPL GMV' or 'Urgent: 3 days no revenue, soft churn signal — call today')."
}

Rules:
Each keyPoint is one punchy line. Lead with the label in caps.
Only include a keyPoint if there is actual data or a clear flag. Skip lines with no data.
If something is clean and healthy, one word: "Clean."
Never pad. Surface what matters. Flag risks bluntly. Call out upsells directly.
Be specific with numbers when available (e.g. "$12k L30 GMV, down 18% vs L60").

ADS-SPECIFIC RULES:
adsSection is REQUIRED for every company — every company has at least a Prospect stage.
The diagnosis line must be specific. "They're not spending more" is bad. "Gating at $10k/day pending 1 week ROAS data per 4d-ago call" is good.
If notes reference a named person blocking progress (Jennifer, the CMO, etc.), name them.
If the blocker is AM-side (bandwidth, no follow-up, no booking link sent), say so plainly. The whole point is internal accountability.
Quote the customer verbatim when their words capture the blocker better than paraphrase.`;

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

  const [recordRes, notes] = await Promise.all([
    hsRequest('GET', `/crm/v3/objects/${objectName}/${recordId}?properties=${properties.join(',')}`),
    fetchRecentNotes(objectName, recordId),
  ]);

  if (!recordRes.ok) {
    return NextResponse.json({ error: 'Failed to fetch record from HubSpot' }, { status: 502 });
  }

  const record = await recordRes.json();
  const prompt = buildPrompt(isDeal, record.properties ?? {}, notes);

  const { text } = await generateText({
    model: anthropic('claude-haiku-4-5-20251001'),
    prompt,
    maxTokens: 2048,
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
