/**
 * Which deployment the user is looking at, and whether the two halves agree.
 *
 * A staging environment that looks like production is how someone eventually
 * runs a destructive test against the wrong one. So this is deliberately hard
 * to get wrong in the dangerous direction and easy to get wrong in the harmless
 * one.
 *
 * ------------------------------------------------------------------
 * Two sources, because one cannot catch the case that matters
 * ------------------------------------------------------------------
 * The build knows what it was built as (VITE_ENVIRONMENT). The API knows what
 * it is running as (/api/version -> environment). A banner driven by the build
 * alone tells you which bundle you loaded; it says nothing about which database
 * is behind it.
 *
 * The dangerous case is a staging bundle talking to the production API -- the
 * page looks safe, is clearly labelled staging, and every write lands on real
 * data. Neither side can detect that alone. Comparing them can, and that is the
 * only reason the API value is fetched at all.
 */

const PRODUCTION = 'production';

/** Normalise: unset, empty, whitespace and case are all the same question. */
export function normalise(value) {
  return String(value ?? '').trim().toLowerCase() || 'unknown';
}

/**
 * Is this an unambiguous production marker?
 *
 * Note the shape: "is it production, and prove it" rather than "is it staging,
 * otherwise assume production". The second treats every misconfiguration as
 * production, which is the wrong default for a page that might be about to
 * write to a database.
 */
export function isProductionValue(value) {
  return normalise(value) === PRODUCTION;
}

/**
 * @param {string|undefined} buildEnv  VITE_ENVIRONMENT, baked in at build time
 * @param {string|null}      apiEnv    /api/version -> environment, or null if
 *                                     it has not answered yet
 *
 * @returns {{kind: 'production'|'labelled'|'mismatch', ...}}
 */
export function classifyEnvironment(buildEnv, apiEnv) {
  const build = normalise(buildEnv);
  const api = apiEnv === null || apiEnv === undefined ? null : normalise(apiEnv);

  /*
   * Disagreement outranks everything, including "both look like production".
   * If the two halves of the app disagree about where they are, the honest
   * answer is that nobody knows -- and that is worth interrupting someone for.
   */
  if (api !== null && api !== 'unknown' && build !== 'unknown' && build !== api) {
    return {
      kind: 'mismatch',
      build,
      api,
      title: 'Environment mismatch',
      body: `This page was built for ${build} but the API reports ${api}. Do not write anything until this is resolved.`
    };
  }

  if (isProductionValue(build) && (api === null || isProductionValue(api))) {
    return { kind: 'production', build, api };
  }

  /*
   * Everything else is labelled. Unset, empty, misspelled, 'staging', 'dev' --
   * all render the banner. Forgetting to configure staging leaves it marked as
   * not-production, which costs nothing; forgetting on production shows a
   * banner to real users, which is embarrassing, immediately visible, and fixed
   * in minutes. Only one of those errors ends with a destructive test on live
   * data.
   */
  const name = build !== 'unknown' ? build : (api ?? 'unknown');
  return {
    kind: 'labelled',
    build,
    api,
    title: name === 'unknown' ? 'Non-production environment' : `${name} environment`,
    body: 'All data here is synthetic. Nothing you do affects real accounts.'
  };
}
