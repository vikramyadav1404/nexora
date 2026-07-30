import { forwardRef } from 'react';

/**
 * Icon-only button with a guaranteed 44px hit area (see primitives.css),
 * a real press state and a focus ring. `label` is required — an icon with
 * no accessible name is invisible to a screen reader.
 */
const IconButton = forwardRef(function IconButton(
  { icon: Icon, label, size = 18, variant = 'plain', small = false, className = '', ...rest },
  ref
) {
  const classes = [
    'icon-btn',
    variant === 'filled' && 'icon-btn--filled',
    small && 'icon-btn--sm',
    className
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button ref={ref} type="button" className={classes} aria-label={label} title={label} {...rest}>
      <Icon size={size} />
    </button>
  );
});

export default IconButton;
