// /api/coradar-report — Vercel serverless function (Node.js runtime).
//
// Generates an illustrative sample competitive-intelligence briefing for
// the CoRadar demo, shaped by the company/competitor context a visitor
// enters. CoRadar has no live monitoring pipeline behind this demo, so
// the model is instructed to produce a clearly hypothetical example
// report rather than real claims about real companies or events.
//
// Cost model: OpenRouter free-tier models only, called in parallel with
// the first valid response winning. Never touches a paid model, so this
// endpoint can never generate a bill.

const MODELS = [
  'minimax/minimax-m3:free',
  'minimax/minimax-m2.7:free',
  'z-ai/glm-5.2:free',
  'liquid/lfm-2.5-2.6b:free',
  'google/gemma-4-26b-a4b-it:free'
];

const SYSTEM_PROMPT = `You are generating an ILLUSTRATIVE SAMPLE competitive-intelligence briefing for a product demo. This is not a real monitoring system: it has no live data feed and no knowledge of real, current events.

Hard rules:
- Never claim or imply that any finding is real, verified, sourced, or reported news. Every finding is a hypothetical example, plausible for the given industry, invented for demonstration purposes only.
- Do not state real facts about the named companies (real funding rounds, real executives, real financials, real product launches) even if you happen to know them. Treat every company name only as a label for a hypothetical scenario.
- Findings must sound like the kind of signal this category of company could plausibly produce (pricing, product, hiring, marketing, positioning), tailored to the given industry and company descriptions, not generic filler.
- Reference the user's own company only to frame why a competitor's move matters to them; never invent facts about the user's own company beyond what they gave you.
- Keep it concise: summary under 40 words, each finding under 30 words, each action under 25 words.
- Never use an em dash (—) anywhere in your output. Use a comma, a period, or a new sentence instead.
- Output ONLY valid JSON. No markdown code fences, no commentary before or after.

Required JSON shape:
{
  "summary": string,          // one line, may include a bold count like "<b>3 material moves</b> this period"
  "findings": [ { "competitor": string, "cat": "Pricing"|"Product"|"Hiring"|"Marketing"|"Positioning", "imp": "high"|"medium"|"low", "text": string } ],  // exactly 5 items, spread across at least 3 of the given competitors
  "actions": [ string ]       // exactly 3 items, concrete next steps for the user's company
}`;

function buildUserPrompt(input) {
  return [
    `My company: ${input.companyName}`,
    `Industry: ${input.industry}`,
    `Market / location: ${input.location || 'not provided'}`,
    `What we do: ${input.description || 'not provided'}`,
    `Competitors to build hypothetical findings about: ${input.competitors.join(', ')}`,
    `Report window: last ${input.days} days`,
    ``,
    `Write the JSON now. Remember: every finding is an invented example for a demo, never a real claim about these companies.`
  ].join('\n');
}

function safeParseJSON(raw) {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { return null; }
    }
    return null;
  }
}

function stripEmDash(value) {
  if (typeof value === 'string') return value.replace(/\s*—\s*/g, ', ').replace(/,\s*,/g, ',');
  if (Array.isArray(value)) return value.map(stripEmDash);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k in value) out[k] = stripEmDash(value[k]);
    return out;
  }
  return value;
}

const IMPACTS = new Set(['high', 'medium', 'low']);
const CATEGORIES = new Set(['Pricing', 'Product', 'Hiring', 'Marketing', 'Positioning']);

function isValidShape(a) {
  return a &&
    typeof a.summary === 'string' && a.summary.length > 0 &&
    Array.isArray(a.findings) && a.findings.length > 0 && a.findings.length <= 6 &&
    a.findings.every(f => f && typeof f.competitor === 'string' && CATEGORIES.has(f.cat) && IMPACTS.has(f.imp) && typeof f.text === 'string') &&
    Array.isArray(a.actions) && a.actions.length > 0 && a.actions.every(x => typeof x === 'string');
}

function validateInput(body) {
  if (!body || typeof body !== 'object') return false;
  if (typeof body.companyName !== 'string' || !body.companyName.trim() || body.companyName.length > 80) return false;
  if (typeof body.industry !== 'string' || !body.industry.trim() || body.industry.length > 80) return false;
  if (body.location != null && (typeof body.location !== 'string' || body.location.length > 80)) return false;
  if (body.description != null && (typeof body.description !== 'string' || body.description.length > 240)) return false;
  if (!Array.isArray(body.competitors) || body.competitors.length < 1 || body.competitors.length > 6) return false;
  if (!body.competitors.every(c => typeof c === 'string' && c.trim().length > 0 && c.length <= 60)) return false;
  if (typeof body.days !== 'number' || body.days < 1 || body.days > 365) return false;
  return true;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, reason: 'method_not_allowed' });
    return;
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    res.status(200).json({ ok: false, reason: 'not_configured' });
    return;
  }

  const input = req.body;
  if (!validateInput(input)) {
    res.status(400).json({ ok: false, reason: 'invalid_input' });
    return;
  }

  const userPrompt = buildUserPrompt(input);
  const site = process.env.PUBLIC_SITE_URL || 'https://humanetheory.ai';

  // Free-tier OpenRouter models can take 10-20s+ to respond under load, so
  // trying them one after another with a short per-model timeout starves
  // every attempt. Race them in parallel instead: first valid response wins.
  async function callModel(model) {
    const controller = new AbortController();
    const perModelTimeout = setTimeout(() => controller.abort(), 25000);
    try {
      const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': site,
          'X-Title': 'Humane Theory, CoRadar'
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt }
          ],
          max_tokens: 1200,
          temperature: 0.6,
          response_format: { type: 'json_object' }
        })
      });
      if (upstream.status === 429 || upstream.status >= 500 || !upstream.ok) return null;

      const data = await upstream.json();
      const raw = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      const parsed = safeParseJSON(raw);
      if (!parsed || !isValidShape(parsed)) return null;

      return { model, report: stripEmDash(parsed) };
    } catch {
      return null;
    } finally {
      clearTimeout(perModelTimeout);
    }
  }

  const results = await Promise.allSettled(MODELS.map(callModel));
  const win = results.find(r => r.status === 'fulfilled' && r.value);
  if (win) {
    res.status(200).json({ ok: true, model: win.value.model, report: win.value.report });
    return;
  }

  res.status(200).json({ ok: false, reason: 'unavailable' });
}
