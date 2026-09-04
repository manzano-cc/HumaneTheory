// /api/aiact-analysis — Vercel serverless function (Node.js runtime).
//
// Enriches the AI-ACT (EU AI Act readiness) assessment with a short,
// grounded note: a rare top-of-page alert only when something is
// genuinely notable (a serious gap, or an unusually strong result),
// plus a quiet pros/cons note at the bottom. The model reasons only
// over the already-computed scores it is given; it never invents a
// score, an obligation, or a legal conclusion.
//
// Cost model: OpenRouter free-tier models only, called in parallel with
// the first valid response winning. Never touches a paid model.

const MODELS = [
  'minimax/minimax-m3:free',
  'minimax/minimax-m2.7:free',
  'z-ai/glm-5.2:free',
  'liquid/lfm-2.5-2.6b:free',
  'google/gemma-4-26b-a4b-it:free'
];

const SYSTEM_PROMPT = `You are a careful AI governance analyst writing a short enrichment note for an EU AI Act readiness report.

Hard rules:
- Use ONLY the figures and labels given to you in the user message. Never invent obligations, articles, legal conclusions, statistics, or benchmarks that were not provided.
- This is NOT legal advice and must never claim to be. Never state that something "complies" or "violates" the law; only comment on readiness and maturity as measured by the given scores.
- Be specific to the given industry, risk tier and weakest areas. Avoid generic filler that could apply to any company.
- "alert" must be null in the ordinary case. Only set it when the data genuinely warrants standing out: a "prohibited" or "high" risk tier combined with weak oversight/documentation scores (severity "critical"), or an unusually strong, consistent result across every category (severity "positive"). Most assessments should get alert: null.
- Keep it concise: diagnosis under 70 words, alert text under 35 words if present, each pro/con under 22 words.
- Never use an em dash (—) anywhere in your output. Use a comma, a period, or a new sentence instead.
- Write the entire response in the language given (an ISO code: "en" or "es"). Every string in the JSON must be in that language.
- Output ONLY valid JSON. No markdown code fences, no commentary before or after.

Required JSON shape:
{
  "alert": null OR { "severity": "critical" | "positive", "text": string },
  "diagnosis": string,
  "pros": [ string ],   // exactly 2 items
  "cons": [ string ]    // exactly 2 items
}`;

function buildUserPrompt(input) {
  return [
    `Language for the response: ${input.lang}`,
    `Industry: ${input.industry}`,
    `Company size: ${input.companySize}`,
    `Country / region: ${input.country || 'not provided'}`,
    `Overall readiness score: ${input.overall} / 100`,
    `EU AI Act readiness score: ${input.euReadiness} / 100`,
    `Risk tier (from selected use cases): ${input.tier}`,
    `Risk exposure band: ${input.riskId}`,
    `Maturity level label: ${input.levelLabel}`,
    `Three strongest areas: ${input.strengths.join(', ')}`,
    `Three weakest areas (priority gaps): ${input.gaps.join(', ')}`,
    `Sensitive use cases flagged (high risk or prohibited tier), if any: ${input.sensitiveUseCases || 'none'}`,
    ``,
    `Write the JSON now.`
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

function isValidShape(a) {
  if (!a || typeof a !== 'object') return false;
  if (typeof a.diagnosis !== 'string' || !a.diagnosis) return false;
  if (!Array.isArray(a.pros) || !a.pros.every(x => typeof x === 'string')) return false;
  if (!Array.isArray(a.cons) || !a.cons.every(x => typeof x === 'string')) return false;
  if (a.alert !== null) {
    if (typeof a.alert !== 'object') return false;
    if (a.alert.severity !== 'critical' && a.alert.severity !== 'positive') return false;
    if (typeof a.alert.text !== 'string' || !a.alert.text) return false;
  }
  return true;
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

function validateInput(body) {
  if (!body || typeof body !== 'object') return false;
  if (typeof body.overall !== 'number') return false;
  if (typeof body.industry !== 'string' || body.industry.length > 80) return false;
  if (typeof body.companySize !== 'string' || body.companySize.length > 40) return false;
  if (typeof body.country === 'string' && body.country.length > 80) return false;
  if (!Array.isArray(body.strengths) || !Array.isArray(body.gaps)) return false;
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
          'X-Title': 'Humane Theory, AI-ACT'
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt }
          ],
          max_tokens: 900,
          temperature: 0.4,
          response_format: { type: 'json_object' }
        })
      });
      if (upstream.status === 429 || upstream.status >= 500 || !upstream.ok) return null;

      const data = await upstream.json();
      const raw = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      const parsed = safeParseJSON(raw);
      if (!parsed || !isValidShape(parsed)) return null;

      return { model, analysis: stripEmDash(parsed) };
    } catch {
      return null;
    } finally {
      clearTimeout(perModelTimeout);
    }
  }

  const results = await Promise.allSettled(MODELS.map(callModel));
  const win = results.find(r => r.status === 'fulfilled' && r.value);
  if (win) {
    res.status(200).json({ ok: true, model: win.value.model, analysis: win.value.analysis });
    return;
  }

  res.status(200).json({ ok: false, reason: 'unavailable' });
}
