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

        {/*
          The whole banner is the target, not just the button in its corner.
          Aiming for a small labelled button is fiddly on a phone, and people
          reasonably expect to tap the picture they want to replace. The button
          stays as the visible affordance — nothing signals "this is clickable"
          on a plain image otherwise — but it sits above this layer, so tapping
          either works and Remove still does its own thing.
        */}
        {editable && (
          <button
            type="button"
            className="profile-cover-hit"
            onClick={onPickCover}
            disabled={busy === 'cover'}
            aria-label={cover ? 'Change cover image' : 'Add cover image'}
            title={cover ? 'Change cover image' : 'Add cover image'}
          />
        )}

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
          {editable ? (
            /*
              The picture itself is the button. The camera badge used to be the
              only way in — a 36px target in the corner of a 132px photo, which
              is both hard to hit and not where anyone aims. The badge is now
              decoration inside the button rather than a separate control.
            */
            <button
              type="button"
              className="profile-avatar-hit"
              onClick={onPickAvatar}
              disabled={busy === 'avatar'}
              aria-label="Change profile picture"
              title="Change profile picture"
            >
              <Avatar
                src={user?.avatarUrl || user?.avatar}
                name={user?.name}
                userId={userId}
                size={132}
                ring
              />
              <span className="profile-avatar-veil" aria-hidden="true">
                <Camera size={28} />
              </span>
              <span className="profile-avatar-edit" aria-hidden="true">
                <Camera size={16} />
              </span>
            </button>
          ) : (
            <Avatar
              src={user?.avatarUrl || user?.avatar}
              name={user?.name}
              userId={userId}
              size={132}
              ring
            />
          )}
        </div>

        <div className="profile-identity-body">{children}</div>
      </div>
    </header>
  );
}
