/**
 * @vitest-environment jsdom
 *
 * Search "Load more" (migration 022): the first response carries a cursor per
 * ranked list; clicking asks for that list's next page with the cursor, appends
 * what came back, and replaces the cursor. Failure keeps what is shown.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const get = vi.fn();
vi.mock('../services/api', () => ({ default: { get } }));

const SearchPage = (await import('./Search.jsx')).default;

const post = (n) => ({ _id: `p${n}`, id: `p${n}`, content: `post ${n}`, author: { name: 'Asha' } });

function firstPage({ postsCursor = 'c1' } = {}) {
  return {
    people: [], questions: [], spaces: [], query: 'post',
    posts: [post(1), post(2)],
    more: { posts: postsCursor, questions: null }
  };
}

function renderAt(url = '/search?q=post') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes><Route path="/search" element={<SearchPage />} /></Routes>
    </MemoryRouter>
  );
}

beforeEach(() => { get.mockReset(); });
afterEach(() => { cleanup(); });

describe('Search: load more', () => {
  it('asks for the next page with the cursor and appends it, then hides the button at the end', async () => {
    get.mockImplementation((url, config) => {
      if (config?.params?.type === 'posts') {
        return Promise.resolve({ data: { type: 'posts', items: [post(3)], nextCursor: null } });
      }
      return Promise.resolve({ data: firstPage() });
    });

    renderAt();
    fireEvent.click(await screen.findByRole('button', { name: 'Load more posts' }));

    await screen.findByText('post 3');
    const call = get.mock.calls.find(([, c]) => c?.params?.type === 'posts');
    expect(call[1].params).toEqual({ q: 'post', type: 'posts', cursor: 'c1' });
    expect(screen.getByText('post 1')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Load more posts' })).toBeNull());
  });

  it('shows no button when the first page was the last', async () => {
    get.mockResolvedValue({ data: firstPage({ postsCursor: null }) });
    renderAt();
    await screen.findByText('post 1');
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull();
  });

  it('a failed page keeps what is shown and lets the same button retry', async () => {
    let failNext = true;
    get.mockImplementation((url, config) => {
      if (config?.params?.type === 'posts') {
        if (failNext) { failNext = false; return Promise.reject(new Error('500')); }
        return Promise.resolve({ data: { type: 'posts', items: [post(3)], nextCursor: 'c2' } });
      }
      return Promise.resolve({ data: firstPage() });
    });

    renderAt();
    fireEvent.click(await screen.findByRole('button', { name: 'Load more posts' }));
    await screen.findByText(/couldn't load more/i);
    expect(screen.getByText('post 2')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Load more posts' }));
    await screen.findByText('post 3');
    const cursors = get.mock.calls.filter(([, c]) => c?.params?.type === 'posts').map(([, c]) => c.params.cursor);
    expect(cursors).toEqual(['c1', 'c1']);  // the retry reused the cursor that failed
    expect(screen.getByRole('button', { name: 'Load more posts' })).toBeTruthy();  // c2 is next
  });

  it('does not show a row twice if a page repeats one', async () => {
    get.mockImplementation((url, config) => {
      if (config?.params?.type === 'posts') {
        return Promise.resolve({ data: { type: 'posts', items: [post(2), post(3)], nextCursor: null } });
      }
      return Promise.resolve({ data: firstPage() });
    });

    renderAt();
    fireEvent.click(await screen.findByRole('button', { name: 'Load more posts' }));
    await screen.findByText('post 3');
    expect(screen.getAllByText('post 2')).toHaveLength(1);
  });
});
