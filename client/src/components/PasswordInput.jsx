import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

/**
 * A password field with a show/hide toggle.
 *
 * The login form and the signup form each carried their own copy: same input,
 * same `showPw` state, same absolutely-positioned eye button, differing only in
 * icon size and a few pixels of offset. Those differences are now the `compact`
 * variant rather than a reason to keep two of everything.
 *
 * `showPw` lives here because nothing outside needs it. Both callers only ever
 * used it to flip this one input's type.
 *
 * Styling is in styles/primitives.css under .pw-field — it was ~9 lines of
 * inline style object in both places.
 */
export default function PasswordInput({
  id,
  value,
  onChange,
  placeholder = 'Password',
  autoComplete = 'current-password',
  required = true,
  compact = false,
  wrapperStyle
}) {
  const [showPw, setShowPw] = useState(false);

  return (
    <div
      className={`form-group pw-field${compact ? ' pw-field-compact' : ''}`}
      style={wrapperStyle}
    >
      <input
        id={id}
        type={showPw ? 'text' : 'password'}
        className="form-input"
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        required={required}
        autoComplete={autoComplete}
      />
      <button
        type="button"
        className="pw-toggle"
        onClick={() => setShowPw(!showPw)}
        // The signup copy had no label, so its toggle was an unnamed button to
        // a screen reader. Sharing one component fixes that everywhere at once.
        aria-label={showPw ? 'Hide password' : 'Show password'}
      >
        {showPw ? <EyeOff size={compact ? 16 : 18} /> : <Eye size={compact ? 16 : 18} />}
      </button>
    </div>
  );
}
