import { Camera, Trash2 } from 'lucide-react';
import Avatar from './ui/Avatar';
import { mediaUrl } from '../utils/mediaUrl';

/**
 * Cover banner with the avatar overlapping its bottom edge.
 *
 * The gradient scrim is not decoration. Cover images are user-supplied, so the
 * name and bio sit on top of something completely unpredictable — a dark wash
 * at the bottom is what keeps that text readable over a white sky or a bright
 * photo. When no cover is set, the brand gradient stands in so the header still
 * looks deliberate rather than broken.
 */
export default function ProfileHeader({
  user,
  editable = false,
  busy = null,
  onPickCover,
  onRemoveCover,
  onPickAvatar,
  children
}) {
  const cover = user?.coverUrl ? mediaUrl(user.coverUrl) : '';
  const userId = user?._id || user?.id || '';

  return (
    <header className="profile-header">
      <div
        className={`profile-cover ${cover ? 'has-image' : ''}`}
        style={cover ? { backgroundImage: `url(${cover})` } : undefined}
      >
        <div className="profile-cover-scrim" aria-hidden="true" />

        {editable && (
          <div className="profile-cover-actions">
            <button
              type="button"
              className="profile-media-btn"
              onClick={onPickCover}
              disabled={busy === 'cover'}
            >
              <Camera size={15} />
              {busy === 'cover' ? 'Working…' : cover ? 'Change cover' : 'Add cover'}
            </button>
            {cover && (
              <button
                type="button"
                className="profile-media-btn"
                onClick={onRemoveCover}
                disabled={busy === 'cover'}
                aria-label="Remove cover image"
              >
                <Trash2 size={15} />
              </button>
            )}
          </div>
        )}
      </div>

      <div className="profile-identity">
        <div className="profile-avatar-slot">
          <Avatar
            src={user?.avatarUrl || user?.avatar}
            name={user?.name}
            userId={userId}
            size={132}
            ring
          />
          {editable && (
            <button
              type="button"
              className="profile-avatar-edit"
              onClick={onPickAvatar}
              disabled={busy === 'avatar'}
              aria-label="Change profile picture"
            >
              <Camera size={16} />
            </button>
          )}
        </div>

        <div className="profile-identity-body">{children}</div>
      </div>
    </header>
  );
}
