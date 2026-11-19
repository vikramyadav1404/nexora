/**
 * @vitest-environment jsdom
 *
 * Recurring checkout (migration 024): for a plan the server marks recurring,
 * Subscribe opens Razorpay on a subscription (not an order) and verifies the
 * payment against /verify-subscription; an auto-renewing plan offers "Turn off
 * auto-renew", not "End it now".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const get = vi.fn();
const post = vi.fn();
vi.mock('../services/api', () => ({ default: { get, post } }));

let authUser;
const refreshUser = vi.fn();
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: authUser, refreshUser }) }));
vi.mock('react-hot-toast', () => ({ default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

const Subscriptions = (await import('./Subscriptions.jsx')).default;

let razorpayOptions;

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  refreshUser.mockReset();
  razorpayOptions = null;
  authUser = { name: 'Payer', email: 'p@n.test', subscription: { plan: 'free', expiresAt: null } };

  get.mockImplementation((url) => {
    if (url === '/api/subscriptions/plans') {
      return Promise.resolve({ data: { paymentsAvailable: true, recurring: { bronze: false, silver: false, gold: true } } });
    }
    return Promise.resolve({ data: { transactions: [] } });
  });
  post.mockImplementation((url) => {
    if (url === '/api/subscriptions/create-subscription') {
      return Promise.resolve({ data: { subscriptionId: 'sub_1', keyId: 'rzp_test_x', plan: 'gold' } });
    }
    return Promise.resolve({ data: {} });
  });
  // Checkout script already "loaded": the page uses window.Razorpay directly.
  window.Razorpay = function Razorpay(options) { razorpayOptions = options; this.open = () => {}; };
});

afterEach(() => { cleanup(); delete window.Razorpay; });

const renderPage = () => render(<MemoryRouter><Subscriptions /></MemoryRouter>);

/** The Subscribe button inside the card whose heading is `name`. */
async function subscribeTo(name) {
  await waitFor(() => expect(get).toHaveBeenCalledWith('/api/subscriptions/plans'));
  const heading = await screen.findByRole('heading', { name });
  let card = heading.parentElement;
  while (card && !card.querySelector('button')) card = card.parentElement;
  const button = [...card.querySelectorAll('button')].find(b => /subscribe/i.test(b.textContent));
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
}

describe('recurring checkout', () => {
  it('opens Razorpay on a subscription and verifies with its id', async () => {
    renderPage();
    await subscribeTo('Gold');

    await waitFor(() => expect(razorpayOptions).not.toBeNull());
    expect(post).toHaveBeenCalledWith('/api/subscriptions/create-subscription', { plan: 'gold' });
    expect(razorpayOptions.subscription_id).toBe('sub_1');
    expect(razorpayOptions.order_id).toBeUndefined();

    await razorpayOptions.handler({
      razorpay_payment_id: 'pay_1', razorpay_subscription_id: 'sub_1', razorpay_signature: 'sig'
    });
    expect(post).toHaveBeenCalledWith('/api/subscriptions/verify-subscription', {
      razorpayPaymentId: 'pay_1', razorpaySubscriptionId: 'sub_1', razorpaySignature: 'sig'
    });
  });

  it('a plan without a recurring id still uses the one-time order', async () => {
    renderPage();
    await subscribeTo('Silver');
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/subscriptions/create-order', { plan: 'silver' }));
    expect(post).not.toHaveBeenCalledWith('/api/subscriptions/create-subscription', expect.anything());
  });

  it('an auto-renewing plan offers to turn auto-renew off, not to forfeit days', async () => {
    authUser = {
      ...authUser,
      subscription: { plan: 'gold', expiresAt: new Date(Date.now() + 20 * 86400000).toISOString(), autoRenew: true }
    };
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off auto-renew' }));
    expect(screen.getByText(/No further charges/)).toBeTruthy();
    expect(screen.queryByText(/gives .* up/)).toBeNull();
  });
});
