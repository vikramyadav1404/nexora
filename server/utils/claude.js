/**
 * Claude client for Nexora's AI features.
 *
 * routes/ai.js used to return hardcoded string templates dressed up as AI. This
 * is the real thing.
 *
 * Conventions used throughout:
 *   - Model is claude-opus-5. Cost/latency is tuned per route with
 *     `output_config.effort` rather than by switching to a weaker model.
 *   - The Nexora context preamble is marked with cache_control so repeat calls
 *     read it from cache instead of re-billing it. Opus 5's minimum cacheable
 *     prefix is 512 tokens, which the preamble clears.
 *   - Every call opts into server-side refusal fallbacks, so a safety-classifier
 *     decline gets answered by another model instead of failing the request.
 */
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-opus-5';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

let client = null;

function getClaude() {
  if (client) return client;
  if (!process.env.ANTHROPIC_API_KEY) {
    const err = new Error('AI features are not configured. Set ANTHROPIC_API_KEY in server/.env');
    err.status = 503;
    throw err;
  }
  client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

function isConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

/**
 * Shared context, cached across calls.
 *
 * Keep this block byte-stable — interpolating anything per-request (a name, a
 * timestamp) invalidates the cache prefix and silently doubles cost.
 */
const NEXORA_CONTEXT = `You are the writing assistant built into Nexora, a community platform where people share posts and ask each other questions.

About the community:
- Questions are practical and answered by peers, not experts on a payroll. Answers that admit uncertainty are more useful here than answers that bluff.
- Members span a wide range of experience. Assume competence, not expertise.
- Posts are short and social. Questions are longer and technical.
- The interest areas are things like technology, music, gaming, sports, fitness, food, travel, movies, fashion, art, books, science, business, education, health and photography.

How to write for Nexora:
- Plain language. No corporate register, no filler openers like "Great question!".
- Be specific. A concrete step beats a general principle.
- Match the length to the question. A one-line question does not need five paragraphs.
- Never invent facts, statistics, links, or library APIs. If something depends on details you were not given, say which details you would need.
- Do not moralise, and do not add disclaimers that a reasonable adult does not need.
- Write in the voice of a helpful member of the community, not a branded assistant.`;

/** The system block, with the cache breakpoint on the stable preamble. */
function systemBlocks(taskInstruction) {
  const blocks = [
    { type: 'text', text: NEXORA_CONTEXT, cache_control: { type: 'ephemeral' } }
  ];
  // Task-specific text goes AFTER the breakpoint so it never invalidates it.
  if (taskInstruction) blocks.push({ type: 'text', text: taskInstruction });
  return blocks;
}

/** Shared request scaffolding. */
function baseParams({ effort = 'high', maxTokens = 2048, system, messages }) {
  return {
    model: MODEL,
    max_tokens: maxTokens,
    system: systemBlocks(system),
    messages,
    thinking: { type: 'adaptive' },
    output_config: { effort },
    betas: [FALLBACK_BETA],
    // Safety classifiers can decline; route to a fallback rather than 500.
    fallbacks: 'default'
  };
}

/**
 * Non-streaming call returning plain text.
 * Throws a tagged error on refusal so callers can respond sensibly.
 */
async function complete({ system, prompt, effort = 'high', maxTokens = 2048 }) {
  const res = await getClaude().beta.messages.create(
    baseParams({ effort, maxTokens, system, messages: [{ role: 'user', content: prompt }] })
  );

  if (res.stop_reason === 'refusal') {
    const err = new Error('The assistant declined to answer that.');
    err.status = 422;
    err.refusal = res.stop_details?.category || null;
    throw err;
  }

  const text = res.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  return { text, usage: res.usage };
}

/**
 * Structured call — the response is validated against `schema` by the API, so
 * callers get a parsed object rather than a string they have to hope is JSON.
 */
async function completeStructured({ system, prompt, schema, effort = 'low', maxTokens = 1024 }) {
  const res = await getClaude().beta.messages.create({
    ...baseParams({ effort, maxTokens, system, messages: [{ role: 'user', content: prompt }] }),
    output_config: {
      effort,
      format: { type: 'json_schema', schema }
    }
  });

  if (res.stop_reason === 'refusal') {
    const err = new Error('The assistant declined to answer that.');
    err.status = 422;
    throw err;
  }

  const raw = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return { data: JSON.parse(raw), usage: res.usage };
  } catch {
    const err = new Error('The assistant returned an unexpected format.');
    err.status = 502;
    throw err;
  }
}

/**
 * Streams text to an Express response as Server-Sent Events.
 *
 * Drafting an answer can take longer than the client's 30s axios timeout, so
 * this route streams instead of buffering.
 */
async function streamToSSE(res, { system, prompt, effort = 'high', maxTokens = 4096 }) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    const stream = getClaude().beta.messages.stream(
      baseParams({ effort, maxTokens, system, messages: [{ role: 'user', content: prompt }] })
    );

    stream.on('text', (delta) => send('delta', { text: delta }));

    const final = await stream.finalMessage();

    if (final.stop_reason === 'refusal') {
      send('error', { message: 'The assistant declined to answer that.' });
    } else {
      send('done', {
        usage: {
          input: final.usage?.input_tokens,
          output: final.usage?.output_tokens,
          cacheRead: final.usage?.cache_read_input_tokens
        }
      });
    }
  } catch (err) {
    console.error('[claude] stream failed:', err.message);
    send('error', { message: friendlyMessage(err) });
  } finally {
    res.end();
  }
}

/** Maps SDK errors onto something a user should see. */
function friendlyMessage(err) {
  if (err instanceof Anthropic.RateLimitError) return 'The assistant is busy right now. Try again shortly.';
  if (err instanceof Anthropic.AuthenticationError) return 'AI features are misconfigured on the server.';
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the assistant. Check your connection.';
  if (err.status === 422) return err.message;
  return 'The assistant could not complete that request.';
}

/** HTTP status to return for an SDK error. */
function statusFor(err) {
  if (err instanceof Anthropic.RateLimitError) return 429;
  if (err instanceof Anthropic.AuthenticationError) return 503;
  if (err instanceof Anthropic.APIConnectionError) return 503;
  return err.status || 502;
}

module.exports = {
  MODEL,
  getClaude,
  isConfigured,
  complete,
  completeStructured,
  streamToSSE,
  friendlyMessage,
  statusFor
};
