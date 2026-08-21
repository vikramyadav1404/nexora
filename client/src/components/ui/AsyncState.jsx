import ErrorState from './ErrorState';
import EmptyState from './EmptyState';

/**
 * Renders one of loading / error / empty / content, and will not let you skip
 * the middle one.
 *
 * useResource reports which of three things happened. This is what makes acting
 * on it unavoidable: children are a function, called only when status is
 * 'ready', so there is no expression you can write here that shows an empty
 * state without the request having succeeded first. That was the actual bug in
 * seven pages -- not that they handled errors badly, but that the error branch
 * was easy to simply not write, and the result looked like a legitimate empty
 * list.
 *
 * The branch order matters: error is checked before empty. A failed request has
 * no data, so testing emptiness first would classify every failure as empty --
 * which is precisely the bug, reintroduced one level up.
 *
 * @param {object} props
 * @param {{status: string, data: any, reload: Function}} props.resource - from useResource
 * @param {React.ReactNode} props.skeleton - shown while loading
 * @param {object} [props.error] - props forwarded to ErrorState (title, description)
 * @param {object} [props.empty] - props forwarded to EmptyState (icon, title, description, action)
 * @param {(data: any) => boolean} [props.isEmpty] - defaults to "empty array or null"
 * @param {(data: any) => React.ReactNode} props.children
 */
export default function AsyncState({
  resource,
  skeleton = null,
  error = {},
  empty = null,
  isEmpty,
  children
}) {
  const { status, data, reload } = resource;

  if (status === 'loading') return skeleton;

  if (status === 'error') {
    return (
      <ErrorState
        title={error.title || 'Could not load this'}
        description={error.description}
        // The retry is the difference between a dead end and a hiccup. It is
        // wired by default rather than left to each caller to remember.
        onRetry={error.onRetry || reload}
        retryLabel={error.retryLabel}
      />
    );
  }

  const looksEmpty = isEmpty
    ? isEmpty(data)
    : data == null || (Array.isArray(data) && data.length === 0);

  // `empty` is optional: some callers render their own zero state inline, and
  // forcing an EmptyState on them would be worse than letting them through.
  if (looksEmpty && empty) {
    return (
      <EmptyState
        icon={empty.icon}
        title={empty.title}
        description={empty.description}
        action={empty.action}
      />
    );
  }

  return children(data);
}
