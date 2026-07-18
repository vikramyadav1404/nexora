/**
 * Smoke test: health + ready endpoints.
 * Usage: node scripts/smoke.js [baseUrl]
 */
const base = (process.argv[2] || `http://127.0.0.1:${process.env.PORT || 5000}`).replace(/\/$/, '');

async function get(path) {
  const res = await fetch(`${base}${path}`);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function main() {
  console.log('Smoke base:', base);
  const ready = await get('/api/ready');
  const health = await get('/api/health');
  console.log('ready:', ready.status, ready.body);
  console.log('health:', health.status, {
    status: health.body?.status,
    realBackend: health.body?.realBackend,
    storage: health.body?.storage,
    emailConfigured: health.body?.emailConfigured
  });

  const ok =
    (ready.status === 200 && ready.body?.ready === true) ||
    (health.status === 200 && (health.body?.status === 'OK' || health.body?.db === 'demo-memory'));

  if (!ok) {
    console.error('❌ Smoke failed');
    process.exit(1);
  }
  console.log('✅ Smoke OK');
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
