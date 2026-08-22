import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from '../services/api';
import useResource from '../hooks/useResource';
import { ErrorState } from '../components/ui';
import { useAuth } from '../contexts/AuthContext';
import { Trophy, Star, ArrowRight, Gift } from 'lucide-react';
import { Avatar } from '../components/ui';

export default function Leaderboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [tab, setTab] = useState('top');

  /*
   * Two independent requests, two independent states. The transfers fetch used
   * to swallow its error entirely, so a failure rendered "No transfers yet" --
   * and the leaderboard toasted but still left an empty list behind the toast,
   * reading as "no users yet, start answering questions to earn points".
   */
  const boardRes = useResource(
    (signal) => axios.get('/api/rewards/leaderboard', { signal }).then(r => r.data.leaderboard || []),
    []
  );
  const transfersRes = useResource(
    (signal) => axios.get('/api/rewards/transfers', { signal }).then(r => r.data.transfers || []),
    []
  );

  const leaderboard = boardRes.data || [];
  const transfers = transfersRes.data || [];

  const BADGE_EMOJI = { bronze: '🥉', silver: '🥈', gold: '🥇', contributor: '✍️', expert: '🎓' };
  const RANK_COLORS = { 0: '#ffd700', 1: '#c0c0c0', 2: '#cd7f32' };

  const currentUserId = user?._id || user?.id;

  return (
    <div className="page-container">
      <div style={{ maxWidth: 700, margin: '0 auto', padding: '32px 24px' }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 36 }}>
          <div style={{
            width: 56, height: 56, margin: '0 auto 12px', borderRadius: '50%',
            background: 'var(--nx-violet-soft)',
            display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}>
            <Trophy size={26} color="#0866FF" />
          </div>
          <h1 style={{ fontSize: 28, marginBottom: 6, fontWeight: 700 }}>
            Leaderboard
          </h1>
          <p style={{ color: 'var(--text-sub)', fontSize: 15 }}>Top contributors ranked by points earned</p>

          {user && (
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 10, marginTop: 16,
              padding: '10px 18px', background: 'var(--bg-surface)',
              borderRadius: 8, boxShadow: '0 1px 2px rgba(0,0,0,0.1)'
            }}>
              <Star size={15} style={{ color: 'var(--gold)' }} fill="#F7B928" />
              <span style={{ fontSize: 14 }}>
                Your points:{' '}
                <strong style={{ color: 'var(--nx-violet)', fontSize: 18 }}>
                  {user.points || 0}
                </strong>
              </span>
            </div>
          )}
        </div>

        {/* Tabs */}
        <div className="tab-bar">
          <button className={`tab-item ${tab === 'top' ? 'active' : ''}`} onClick={() => setTab('top')}>🏅 Top Users</button>
          <button className={`tab-item ${tab === 'history' ? 'active' : ''}`} onClick={() => setTab('history')}>🎁 Point Transfers</button>
          <button className={`tab-item ${tab === 'how' ? 'active' : ''}`} onClick={() => setTab('how')}>❓ How to Earn</button>
        </div>

        {/* TOP USERS */}
        {tab === 'top' && (
          <div>
            {/* Top 3 podium */}
            {/*
              * boardRes.isLoading, not `loading`. This read a bare `loading`
              * that no longer existed after the move to useResource, so the
              * whole page threw a ReferenceError into the error boundary --
              * every render, for everyone.
              */}
            {!boardRes.isLoading && leaderboard.length >= 3 && (
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'flex-end', gap: 12, marginBottom: 28, padding: '0 20px' }}>
                {[
                  { index: 1, height: 100, order: 0 },
                  { index: 0, height: 130, order: 1 },
                  { index: 2, height: 80, order: 2 }
                ].map(({ index, height, order }) => {
                  const person = leaderboard[index];
                  if (!person) return null;
                  const medals = ['🥇', '🥈', '🥉'];
                  const colors = ['#ffd700', '#c0c0c0', '#cd7f32'];
                  return (
                    <div key={index} style={{ flex: 1, textAlign: 'center', order, cursor: 'pointer' }}
                      onClick={() => navigate(`/profile/${person._id}`)}>
                      <div style={{ fontSize: 28, marginBottom: 6 }}>{medals[index]}</div>
                      <Avatar
                        src={person.avatarThumbUrl || person.avatar}
                        name={person.name}
                        userId={person._id || person.id}
                        size={52}
                        style={{ margin: '0 auto 8px', border: `2px solid ${colors[index]}` }}
                      />
                      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>{person.name?.split(' ')[0]}</div>
                      <div style={{ color: colors[index], fontWeight: 800, fontSize: 16 }}>{person.points}</div>
                      <div style={{ height, background: `linear-gradient(to top, ${colors[index]}33, transparent)`, borderRadius: '8px 8px 0 0', marginTop: 8, border: `1px solid ${colors[index]}44` }} />
                    </div>
                  );
                })}
              </div>
            )}

            {/* Full leaderboard */}
            <div className="glass-card" style={{ padding: 8 }}>
              {boardRes.isLoading ? (
                [1,2,3,4,5].map(i => (
                  <div key={i} className="leaderboard-item">
                    <div className="skeleton" style={{ width: 28, height: 28, borderRadius: '50%' }} />
                    <div className="skeleton" style={{ width: 40, height: 40, borderRadius: '50%' }} />
                    <div style={{ flex: 1 }}>
                      <div className="skeleton" style={{ height: 14, width: '40%', marginBottom: 6 }} />
                      <div className="skeleton" style={{ height: 12, width: '25%' }} />
                    </div>
                  </div>
                ))
              ) : boardRes.isError ? (
                /* Checked before emptiness: a failed request has no rows, so
                   testing length first reports every failure as "no users". */
                <ErrorState
                  title="Could not load the leaderboard"
                  onRetry={boardRes.reload}
                />
              ) : leaderboard.length === 0 ? (
                <div className="empty-state" style={{ padding: '40px 0' }}>
                  <Trophy size={40} style={{ margin: '0 auto 12px', opacity: 0.3 }} />
                  <h3>No users yet</h3>
                  <p>Start answering questions to earn points!</p>
                </div>
              ) : (
                leaderboard.map((person, i) => {
                  const isCurrentUser = person._id === currentUserId;
                  return (
                    <div key={person._id}
                      className="leaderboard-item"
                      style={{ cursor: 'pointer', background: isCurrentUser ? 'var(--nx-violet-soft)' : 'transparent', borderRadius: 'var(--radius-md)' }}
                      onClick={() => navigate(`/profile/${person._id}`)}>
                      {/* Rank */}
                      <div className={`rank-number ${i < 3 ? 'gold-rank' : ''}`}
                        style={{ background: RANK_COLORS[i] ? `linear-gradient(135deg, ${RANK_COLORS[i]}, ${RANK_COLORS[i]}88)` : 'linear-gradient(135deg, #7c3aed, #06b6d4)' }}>
                        {i + 1}
                      </div>

                      <Avatar
                        src={person.avatarThumbUrl || person.avatar}
                        name={person.name}
                        userId={person._id || person.id}
                        size={40}
                        style={{ flexShrink: 0 }}
                      />

                      {/* Info */}
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600, fontSize: 15, display: 'flex', alignItems: 'center', gap: 6 }}>
                          {person.name}
                          {isCurrentUser && <span style={{ fontSize: 11, color: 'var(--nx-violet)', background: 'var(--nx-violet-soft)', padding: '1px 8px', borderRadius: 'var(--radius-full)' }}>You</span>}
                        </div>
                        <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                          {person.badges?.map(b => (
                            <span key={b} style={{ fontSize: 14 }}>{BADGE_EMOJI[b]}</span>
                          ))}
                          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{person.totalAnswers || 0} answers</span>
                        </div>
                      </div>

                      {/* Points */}
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: 18, fontWeight: 800, color: i < 3 ? Object.values(RANK_COLORS)[i] : 'var(--accent)' }}>
                          ⭐ {person.points}
                        </div>
                      </div>
                      <ArrowRight size={16} color="var(--text-muted)" />
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}

        {/* POINT TRANSFERS */}
        {tab === 'history' && (
          <div className="glass-card" style={{ padding: 24 }}>
            <h3 style={{ marginBottom: 16 }}>Recent Point Transfers</h3>
            {transfersRes.isError ? (
              <ErrorState
                title="Could not load transfers"
                onRetry={transfersRes.reload}
              />
            ) : transfers.length === 0 ? (
              <div className="empty-state" style={{ padding: '40px 0' }}>
                <Gift size={40} style={{ margin: '0 auto 12px', opacity: 0.3 }} />
                <h3>No transfers yet</h3>
                <p>Point transfers between users will show here</p>
              </div>
            ) : (
              transfers.map(tx => {
                const isSender = tx.from?._id === currentUserId;
                return (
                  <div key={tx._id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 0', borderBottom: '1px solid var(--border-soft)' }}>
                    <div style={{ fontSize: 28 }}>{isSender ? '📤' : '📥'}</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 14, fontWeight: 500 }}>
                        {isSender
                          ? <><span style={{ color: 'var(--danger)' }}>−{tx.points} pts</span> sent to <strong>{tx.to?.name}</strong></>
                          : <><span style={{ color: 'var(--success)' }}>+{tx.points} pts</span> received from <strong>{tx.from?.name}</strong></>
                        }
                      </div>
                      {tx.message && <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 3 }}>"{tx.message}"</div>}
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
                        {new Date(tx.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>
                    <div style={{ fontWeight: 800, fontSize: 16, color: isSender ? 'var(--danger)' : 'var(--success)' }}>
                      {isSender ? '-' : '+'}{tx.points}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* HOW TO EARN */}
        {tab === 'how' && (
          <div className="glass-card" style={{ padding: 24 }}>
            <h3 style={{ marginBottom: 20 }}>How to Earn Points</h3>
            {[
              { icon: '✍️', action: 'Post an Answer', points: '+5 pts', desc: 'Answer any question in the Q&A section' },
              { icon: '👍', action: 'Get 5 Upvotes on Answer', points: '+5 pts', desc: 'When your answer receives 5 upvotes' },
              { icon: '👎', action: 'Receive a Downvote', points: '-1 pt', desc: 'Someone downvotes your answer', negative: true },
              { icon: '🗑️', action: 'Delete Your Answer', points: '-5 pts', desc: 'Deleting an answer removes the earned points', negative: true }
            ].map(item => (
              <div key={item.action} style={{ display: 'flex', gap: 14, padding: '16px 0', borderBottom: '1px solid var(--border-soft)' }}>
                <div style={{ fontSize: 28, flexShrink: 0 }}>{item.icon}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>{item.action}</div>
                  <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{item.desc}</div>
                </div>
                <div style={{ fontWeight: 800, fontSize: 18, color: item.negative ? 'var(--danger)' : 'var(--success)', flexShrink: 0 }}>
                  {item.points}
                </div>
              </div>
            ))}
            <div style={{ marginTop: 20, padding: 16, background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 'var(--radius-md)' }}>
              <h4 style={{ fontSize: 14, marginBottom: 10, color: 'var(--accent)' }}>🎯 Badge Requirements</h4>
              <div style={{ display: 'grid', gap: 8, fontSize: 13 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>🥉 Bronze Badge</span><span style={{ color: 'var(--text-muted)' }}>50+ points</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>🥈 Silver Badge</span><span style={{ color: 'var(--text-muted)' }}>200+ points</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>🥇 Gold Badge</span><span style={{ color: 'var(--text-muted)' }}>500+ points</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>✍️ Contributor Badge</span><span style={{ color: 'var(--text-muted)' }}>10+ answers</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>🎓 Expert Badge</span><span style={{ color: 'var(--text-muted)' }}>50+ answers</span></div>
              </div>
            </div>
            <div style={{ marginTop: 16, padding: 16, background: 'var(--nx-violet-soft)', border: '1px solid var(--border-brand)', borderRadius: 'var(--radius-md)', fontSize: 13, color: 'var(--text-secondary)' }}>
              <strong style={{ color: 'var(--primary-light)' }}>💡 Point Transfer Rules</strong><br/>
              You can transfer points to other users, but:<br/>
              • You must have <strong>more than 10 points</strong> to transfer<br/>
              • You keep at least 10 points after transfer<br/>
              • Only transfer to friends you know
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
