import { Inbox } from 'lucide-react';

/**
 * Shared empty state. Replaces the same markup hand-copied into 14 places.
 *
 * `action` is the affordance the old copies almost always lacked — an empty
 * screen should nearly always offer the next step.
 */
export default function EmptyState({
  icon: Icon = Inbox,
  title = 'Nothing here yet',
  description,
  action,
  className = ''
}) {
  return (
    <div className={`empty-state ${className}`.trim()}>
      <div className="empty-state-icon">
        <Icon size={28} strokeWidth={1.75} />
      </div>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  );
}
