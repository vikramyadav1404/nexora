/**
 * Whether it is safe to write synthetic data into this database.
 *
 * The seeder overwrites and creates accounts. Pointed at production it is a
 * data-destruction tool, so the question "is this really staging?" has to be
 * answered by something better than a variable.
 *
 * ------------------------------------------------------------------
 * The check that matters is derived from the data
 * ------------------------------------------------------------------
 * APP_ENV can be wrong. A stale `.env`, a variable exported in a previous
 * shell, a copied deploy command, a `--env` flag pointing somewhere else. Every
 * config-derived check shares one weakness: it describes intent, and intent is
 * exactly what is wrong when someone runs the wrong command.
 *
 * The rows cannot lie about what they are. **A database containing accounts
 * that are not synthetic is not a staging database**, whatever any variable
 * says. That single query is worth more than every flag combined, because it
 * asks the target rather than the operator.
 *
 * The config checks stay as well -- they are nearly free and they fail earlier,
 * with a clearer message. But they are the outer layer, not the real one.
 */

/**
 * Addresses the seeder is allowed to create and to find.
 *
 * `.invalid` is reserved by RFC 2606 and guaranteed never to resolve, so a
 * synthetic account cannot receive mail even if something tries to send it.
 * `.seed` covers the interest-hub creators that db/interests.js already
 * generates.
 */
const SYNTHETIC_SUFFIXES = ['@nexora.invalid', '@nexora.seed', '@nexora.test'];

function isSyntheticEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  return SYNTHETIC_SUFFIXES.some(suffix => value.endsWith(suffix));
}

/**
 * Ask the database whether it holds anyone real.
 *
 * @returns {Promise<{safe: boolean, total: number, real: number, examples: string[]}>}
 */
async function inspectTarget(db) {
  const { data, error } = await db.from('users').select('email').limit(5000);

  /*
   * A failed read is not permission to proceed.
   *
   * This is the mistake the nightly sweep made twice -- treating "I could not
   * read the data" as "there is no data" -- and it would be far worse here,
   * because the conclusion would be "this database is empty, safe to seed".
   */
  if (error) {
    throw new Error(
      `Cannot verify the target database is safe to seed: ${error.message}. ` +
      'Refusing rather than assuming it is empty.'
    );
  }

  const rows = data || [];
  const real = rows.filter(r => !isSyntheticEmail(r.email));

  return {
    safe: real.length === 0,
    total: rows.length,
    real: real.length,
    // Enough to recognise the database, not enough to be a contact list.
    examples: real.slice(0, 3).map(r => {
      const [name, domain] = String(r.email || '').split('@');
      return `${(name || '').slice(0, 2)}***@${domain || '?'}`;
    })
  };
}

/**
 * Config-derived checks. Cheap, early, and not the real protection.
 *
 * @returns {string[]} reasons to refuse; empty means the config looks right
 */
function configObjections({ appEnv, supabaseUrl, confirmRef }) {
  const problems = [];

  if (String(appEnv || '').trim().toLowerCase() !== 'staging') {
    problems.push(`APP_ENV is "${appEnv || '(unset)'}", not "staging"`);
  }

  const host = String(supabaseUrl || '');
  if (!host) {
    problems.push('SUPABASE_URL is not set');
  } else if (confirmRef && !host.includes(confirmRef)) {
    problems.push(
      `--confirm "${confirmRef}" does not appear in SUPABASE_URL — ` +
      'the target is not the project you named'
    );
  } else if (!confirmRef) {
    problems.push('--confirm <project-ref> is required, naming the target project');
  }

  return problems;
}

module.exports = {
  SYNTHETIC_SUFFIXES,
  isSyntheticEmail,
  inspectTarget,
  configObjections
};
