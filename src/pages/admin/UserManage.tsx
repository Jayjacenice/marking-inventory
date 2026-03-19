import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useStaleGuard } from '../../hooks/useStaleGuard';
import { supabaseAdmin } from '../../lib/supabaseAdmin';
import type { UserRole } from '../../types';
import { Plus, Pencil, Trash2, Eye, EyeOff, X } from 'lucide-react';

interface ManagedUser {
  id: string;
  userId: string;
  name: string;
  role: UserRole;
  created_at: string;
}

const roleLabel: Record<UserRole, string> = {
  admin: '관리자',
  offline: '오프라인 매장',
  playwith: '플레이위즈',
};

const roleColor: Record<UserRole, string> = {
  admin: 'bg-red-100 text-red-700',
  offline: 'bg-blue-100 text-blue-700',
  playwith: 'bg-purple-100 text-purple-700',
};

interface Props {
  currentUserId: string;
}

export default function UserManage({ currentUserId }: Props) {
  const isStale = useStaleGuard();
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingUser, setEditingUser] = useState<ManagedUser | null>(null);

  const [formUserId, setFormUserId] = useState('');
  const [formName, setFormName] = useState('');
  const [formRole, setFormRole] = useState<UserRole>('offline');
  const [formPassword, setFormPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    loadUsers();
  }, []);

  const loadUsers = async () => {
    setLoading(true);
    try {
      const { data: profiles, error: profileErr } = await supabaseAdmin
        .from('user_profile')
        .select('id, name, role, created_at')
        .order('created_at', { ascending: false });
      if (profileErr) throw profileErr;

      if (profiles) {
        const { data: authData } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
        const authMap = new Map<string, string>();
        if (authData?.users) {
          for (const u of authData.users) {
            authMap.set(u.id, u.email || '');
          }
        }

        const mapped: ManagedUser[] = (profiles as any[]).map((p) => {
          const email = authMap.get(p.id) || '';
          const userId = email.endsWith('@marking.internal')
            ? email.replace('@marking.internal', '')
            : email;
          return {
            id: p.id,
            userId,
            name: p.name,
            role: p.role as UserRole,
            created_at: p.created_at,
          };
        });
        if (!isStale()) setUsers(mapped);
      }
    } catch (err) {
      console.error('loadUsers error:', err);
    } finally {
      setLoading(false);
    }
  };

  const resetForm = () => {
    setShowModal(false);
    setEditingUser(null);
    setFormUserId('');
    setFormName('');
    setFormRole('offline');
    setFormPassword('');
    setShowPassword(false);
  };

  const openCreateModal = () => {
    resetForm();
    setShowModal(true);
  };

  const openEditModal = (user: ManagedUser) => {
    setEditingUser(user);
    setFormUserId(user.userId);
    setFormName(user.name);
    setFormRole(user.role);
    setFormPassword('');
    setShowPassword(false);
    setShowModal(true);
  };

  const validate = (): boolean => {
    if (!formUserId.trim()) {
      setMessage({ type: 'error', text: '아이디를 입력해주세요.' });
      return false;
    }
    if (!editingUser && !/^[a-zA-Z0-9_-]+$/.test(formUserId)) {
      setMessage({ type: 'error', text: '아이디는 영문, 숫자, -, _ 만 사용할 수 있습니다.' });
      return false;
    }
    if (!formName.trim()) {
      setMessage({ type: 'error', text: '이름을 입력해주세요.' });
      return false;
    }
    if (!editingUser && !formPassword) {
      setMessage({ type: 'error', text: '비밀번호를 입력해주세요.' });
      return false;
    }
    if (formPassword && formPassword.length < 6) {
      setMessage({ type: 'error', text: '비밀번호는 최소 6자 이상이어야 합니다.' });
      return false;
    }
    return true;
  };

  const handleCreateUser = async () => {
    if (!validate()) return;
    setSaving(true);
    setMessage(null);

    const email = `${formUserId}@marking.internal`;

    try {
      const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.createUser({
        email,
        password: formPassword,
        email_confirm: true,
      });

      if (authError) throw authError;

      const { error: profileError } = await supabaseAdmin
        .from('user_profile')
        .insert({
          id: authUser.user.id,
          name: formName,
          role: formRole,
        });

      if (profileError) throw profileError;

      // 활동 이력 기록 (실패해도 계정 생성에 영향 없음)
      supabase.from('activity_log').insert({
        user_id: currentUserId,
        action_type: 'user_create',
        work_order_id: null,
        action_date: new Date().toISOString().split('T')[0],
        summary: {
          targetUserId: formUserId,
          targetName: formName,
          targetRole: formRole,
          items: [],
          totalQty: 0,
        },
      }).then(({ error }) => { if (error) console.warn('activity_log insert failed:', error.message); });

      setMessage({ type: 'success', text: `계정 "${formUserId}"이(가) 생성되었습니다.` });
      resetForm();
      loadUsers();
    } catch (err: any) {
      const msg = err.message?.includes('already been registered')
        ? '이미 존재하는 아이디입니다.'
        : err.message || '계정 생성 중 오류가 발생했습니다.';
      setMessage({ type: 'error', text: msg });
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateUser = async () => {
    if (!validate()) return;
    if (!editingUser) return;
    setSaving(true);
    setMessage(null);

    try {
      if (formPassword) {
        const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(
          editingUser.id,
          { password: formPassword }
        );
        if (authError) throw authError;
      }

      const { error: profileError } = await supabaseAdmin
        .from('user_profile')
        .update({ name: formName, role: formRole })
        .eq('id', editingUser.id);

      if (profileError) throw profileError;

      // 활동 이력 기록
      const changes: string[] = [];
      if (formName !== editingUser.name) changes.push(`이름: ${editingUser.name} → ${formName}`);
      if (formRole !== editingUser.role) changes.push(`역할: ${editingUser.role} → ${formRole}`);
      if (formPassword) changes.push('비밀번호 변경');

      supabase.from('activity_log').insert({
        user_id: currentUserId,
        action_type: 'user_update',
        work_order_id: null,
        action_date: new Date().toISOString().split('T')[0],
        summary: {
          targetUserId: editingUser.userId,
          targetName: editingUser.name,
          changes,
          items: [],
          totalQty: 0,
        },
      }).then(({ error }) => { if (error) console.warn('activity_log insert failed:', error.message); });

      setMessage({ type: 'success', text: `계정 "${editingUser.userId}" 정보가 수정되었습니다.` });
      resetForm();
      loadUsers();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || '수정 중 오류가 발생했습니다.' });
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteUser = async (user: ManagedUser) => {
    if (user.id === currentUserId) {
      setMessage({ type: 'error', text: '자기 자신의 계정은 삭제할 수 없습니다.' });
      return;
    }
    if (!confirm(`"${user.userId}" 계정을 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.`)) return;

    try {
      await supabaseAdmin.from('user_profile').delete().eq('id', user.id);
      const { error } = await supabaseAdmin.auth.admin.deleteUser(user.id);
      if (error) throw error;

      // 활동 이력 기록 (실패해도 삭제에 영향 없음)
      supabase.from('activity_log').insert({
        user_id: currentUserId,
        action_type: 'user_delete',
        work_order_id: null,
        action_date: new Date().toISOString().split('T')[0],
        summary: {
          targetUserId: user.userId,
          targetName: user.name,
          targetRole: user.role,
          items: [],
          totalQty: 0,
        },
      }).then(({ error: logErr }) => { if (logErr) console.warn('activity_log insert failed:', logErr.message); });

      setMessage({ type: 'success', text: `계정 "${user.userId}"이(가) 삭제되었습니다.` });
      loadUsers();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || '삭제 중 오류가 발생했습니다.' });
    }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-gray-900">계정 관리</h2>
        <button
          onClick={openCreateModal}
          className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
        >
          <Plus size={16} />
          새 계정 추가
        </button>
      </div>

      {message && (
        <div
          className={`flex items-center justify-between rounded-lg px-4 py-3 text-sm ${
            message.type === 'success' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
          }`}
        >
          <span>{message.text}</span>
          <button onClick={() => setMessage(null)} className="ml-2 hover:opacity-70">
            <X size={14} />
          </button>
        </div>
      )}

      {/* 모달 */}
      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-lg w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-gray-900">
                {editingUser ? '계정 수정' : '새 계정 추가'}
              </h3>
              <button onClick={resetForm} className="text-gray-400 hover:text-gray-600">
                <X size={20} />
              </button>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">아이디</label>
              <input
                type="text"
                value={formUserId}
                onChange={(e) => setFormUserId(e.target.value)}
                disabled={!!editingUser}
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-100 disabled:text-gray-500"
                placeholder="아이디 입력"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">이름</label>
              <input
                type="text"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="오프라인 매장 1"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">역할</label>
              <select
                value={formRole}
                onChange={(e) => setFormRole(e.target.value as UserRole)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="offline">오프라인 매장</option>
                <option value="playwith">플레이위즈</option>
                <option value="admin">관리자</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {editingUser ? '새 비밀번호 (변경 시에만 입력)' : '비밀번호'}
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={formPassword}
                  onChange={(e) => setFormPassword(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2.5 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder={editingUser ? '변경하지 않으려면 비워두세요' : '비밀번호 입력'}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-2.5 text-gray-400 hover:text-gray-600"
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            <button
              onClick={editingUser ? handleUpdateUser : handleCreateUser}
              disabled={saving}
              className="w-full bg-blue-600 text-white py-2.5 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-60 transition-colors"
            >
              {saving ? '처리 중...' : editingUser ? '수정' : '생성'}
            </button>
          </div>
        </div>
      )}

      {/* 사용자 목록 */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        {loading ? (
          <div className="text-center py-12 text-gray-400 text-sm">로딩 중...</div>
        ) : users.length === 0 ? (
          <div className="text-center py-12 text-gray-400 text-sm">등록된 계정이 없습니다.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">아이디</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">이름</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">역할</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">생성일</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">관리</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {users.map((user) => (
                <tr key={user.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-gray-900 font-mono text-xs">{user.userId}</td>
                  <td className="px-4 py-3 text-gray-700">{user.name}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${roleColor[user.role]}`}
                    >
                      {roleLabel[user.role]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500">
                    {new Date(user.created_at).toLocaleDateString('ko-KR')}
                  </td>
                  <td className="px-4 py-3 text-right space-x-2">
                    <button
                      onClick={() => openEditModal(user)}
                      className="text-gray-400 hover:text-blue-500 transition-colors"
                      title="수정"
                    >
                      <Pencil size={14} />
                    </button>
                    {user.id !== currentUserId && (
                      <button
                        onClick={() => handleDeleteUser(user)}
                        className="text-gray-400 hover:text-red-500 transition-colors"
                        title="삭제"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
